"""Worker flow tests with network/audio boundaries mocked; no phone calls."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import AsyncMock, Mock, patch


class ToolContext:
    def __init__(self, **kwargs):
        self.function_tools = {}


class Agent:
    def __init__(self, **kwargs):
        self.options = kwargs

    async def update_instructions(self, instructions):
        self.options['instructions'] = instructions


class Session:
    instances = []

    def __init__(self, **kwargs):
        self.events = {}
        self.spoken = []
        self.options = kwargs
        self.instances.append(self)

    def on(self, name):
        def register(callback):
            self.events[name] = callback
            return callback
        return register

    async def start(self, agent, **kwargs):
        self.agent = agent

    async def say(self, text, **kwargs):
        self.spoken.append((text, kwargs))
        # Simulate the remote participant hanging up after the greeting.
        asyncio.get_running_loop().call_soon(self.shutdown)

    def shutdown(self, **kwargs):
        self.events['close'](None)

    async def aclose(self):
        self.shutdown()


def load_worker():
    modules = {}
    attrs = {
        'aiohttp': {'ClientSession': Mock(), 'ClientTimeout': Mock()},
        'livekit': {},
        'livekit.api': {name: lambda **kw: types.SimpleNamespace(**kw) for name in (
            'DeleteRoomRequest', 'CreateSIPParticipantRequest', 'TransferSIPParticipantRequest')},
        'livekit.agents': {
            'AutoSubscribe': types.SimpleNamespace(AUDIO_ONLY='audio'),
            'JobContext': object, 'JobProcess': object, 'WorkerOptions': Mock(), 'cli': Mock(),
        },
        'livekit.agents.llm': {'ToolContext': ToolContext, 'function_tool': lambda **kw: lambda fn: fn, 'ChatMessage': type('ChatMessage', (), {})},
        'livekit.agents.voice': {'Agent': Agent, 'AgentSession': Session, 'RunContext': object},
        'livekit.agents.voice.room_io': {name: Mock() for name in ('AudioInputOptions', 'AudioOutputOptions', 'RoomOptions')},
        'livekit.plugins': {},
    }
    attrs['livekit.api']['ParticipantInfo'] = types.SimpleNamespace(Kind=types.SimpleNamespace(SIP=3))
    for plugin in ('deepgram', 'noise_cancellation', 'openai', 'sarvam', 'silero'):
        attrs['livekit.plugins.' + plugin] = {name: Mock() for name in ('STT', 'TTS', 'LLM', 'VAD', 'BVCTelephony')}
    for name, values in attrs.items():
        item = types.ModuleType(name)
        item.__dict__.update(values)
        modules[name] = item
    for name, item in modules.items():
        parent, _, child = name.rpartition('.')
        if parent in modules:
            setattr(modules[parent], child, item)
    with patch.dict(sys.modules, modules):
        spec = importlib.util.spec_from_file_location('worker_under_test', Path(__file__).with_name('agent.py'))
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
    return worker


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.worker = load_worker()
        self.worker.log_call_to_crm = AsyncMock()
        self.worker.OUTBOUND_SIP_TRUNK_ID = 'test-trunk'
        self.ctx = types.SimpleNamespace(
            job=types.SimpleNamespace(metadata=json.dumps({
                'call_type': 'outbound', 'customer_name': 'Rahul Shah',
                'phone_number': '+919876543210', 'reason': 'Quotation follow-up',
            })),
            room=types.SimpleNamespace(name='test-room', remote_participants={}),
            proc=types.SimpleNamespace(userdata={'vad': object()}),
            api=types.SimpleNamespace(sip=types.SimpleNamespace(create_sip_participant=AsyncMock()),
                                      room=types.SimpleNamespace(delete_room=AsyncMock())),
            connect=AsyncMock(), shutdown=Mock(), add_shutdown_callback=Mock(),
            wait_for_participant=AsyncMock(return_value=types.SimpleNamespace(kind=0, identity='sip_+919876543210')),
        )

    async def test_outbound_pipeline_retains_context_and_logs_once(self):
        with patch.dict(os.environ, {'GROQ_API_KEY': 'test'}):
            await self.worker.entrypoint(self.ctx)
        session = Session.instances[-1]
        self.assertIn('Rahul Shah', session.agent.options['instructions'])
        self.assertIn('+919876543210', session.agent.options['instructions'])
        self.assertIn('Quotation follow-up', session.agent.options['instructions'])
        self.assertIn('Rahul Shah', session.spoken[0][0])
        self.assertTrue(session.spoken[0][1]['add_to_chat_ctx'])
        self.assertTrue(session.options['preemptive_generation'])
        self.assertEqual(session.options['min_endpointing_delay'], 0.25)
        self.assertEqual(session.options['max_endpointing_delay'], 0.8)
        opts = self.worker.openai.LLM.call_args.kwargs
        self.assertEqual(opts['model'], self.worker.GROQ_MODEL)
        self.assertEqual(opts['max_completion_tokens'], self.worker.GROQ_MAX_TOKENS)
        for key, value in self.worker.GROQ_EXTRA_OPTIONS.items():
            self.assertEqual(opts[key], value)
        stt_args = self.worker.deepgram.STT.call_args.kwargs
        self.assertEqual(stt_args['language'], 'multi')
        self.assertIn('Sekol', stt_args['keyterm'])
        room_options = self.worker.RoomOptions.call_args.kwargs
        # RoomIO is deliberately armed before the SIP participant joins and
        # pre-bound to the exact SIP identity, so it captures no other track.
        self.assertEqual(room_options['participant_identity'], 'sip_+919876543210')
        self.assertTrue(room_options['close_on_disconnect'])
        self.ctx.wait_for_participant.assert_awaited_once_with(identity='sip_+919876543210')
        await self.ctx.add_shutdown_callback.call_args.args[0]()
        # The durable lifecycle saves once when the customer answers and once
        # on completion, so the final record has an honest terminal status.
        self.assertGreaterEqual(self.worker.log_call_to_crm.await_count, 2)
        self.assertEqual(self.worker.log_call_to_crm.call_args.kwargs['status'], 'COMPLETED')
        self.ctx.api.room.delete_room.assert_awaited_once()

    async def test_failed_dial_is_logged_without_greeting(self):
        self.ctx.api.sip.create_sip_participant.side_effect = RuntimeError('No answer')
        with patch.dict(os.environ, {'GROQ_API_KEY': 'test'}):
            await self.worker.entrypoint(self.ctx)
        self.assertEqual(Session.instances[-1].spoken, [])
        logged = self.worker.log_call_to_crm.call_args.kwargs
        self.assertEqual(logged['status'], 'NO_ANSWER')
        self.assertEqual(logged['duration_seconds'], 0)

    async def test_browser_without_sip_trunk_still_greets(self):
        self.worker.OUTBOUND_SIP_TRUNK_ID = ''
        self.ctx.job.metadata = ''
        with patch.dict(os.environ, {'GROQ_API_KEY': 'test'}):
            await self.worker.entrypoint(self.ctx)
        self.ctx.api.sip.create_sip_participant.assert_not_awaited()
        self.assertTrue(Session.instances[-1].spoken)

    def test_appointment_details_are_strictly_normalized(self):
        self.assertEqual(
            self.worker._normalize_appointment_details(' Rahul Shah ', '+91 (98765) 43210', '2099-01-01', '2 pm'),
            ('Rahul Shah', '+919876543210', '2099-01-01', '2:00 PM'),
        )
        self.assertIsNone(self.worker._normalize_appointment_details('Rahul', '+919876543210', '2099-01-01', '2:30 PM'))
        self.assertIsNone(self.worker._normalize_appointment_details('Rahul', '9876543210', '2099-01-01', '2 PM'))
        self.assertIsNone(self.worker._normalize_appointment_details('Rahul', '+91916623128', '2099-01-01', '2 PM'))

    def test_outbound_booking_reuses_known_customer_identity(self):
        tools = self.worker.CRMTools(self.ctx, '+919876543210', 'Rahul Shah')
        self.assertEqual(
            self.worker._normalize_appointment_details(
                tools._customer_name, tools._phone_number, '2099-01-01', '11 AM'),
            ('Rahul Shah', '+919876543210', '2099-01-01', '11:00 AM'),
        )

    async def test_invalid_booking_slot_is_always_spoken(self):
        tools = self.worker.CRMTools(self.ctx, '+919876543210', 'Rahul Shah')
        say = AsyncMock()
        result = await tools.schedule_appointment(
            types.SimpleNamespace(session=types.SimpleNamespace(say=say)),
            date='2099-01-01',
            time='1:30 PM',
        )
        say.assert_awaited_once()
        self.assertIn('already spoken', result)

    async def test_booking_requires_database_confirmation_id(self):
        class Response:
            def __init__(self, status, body):
                self.status, self.body = status, body
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                return False
            async def json(self, **kwargs):
                return self.body
            async def text(self):
                return json.dumps(self.body)

        class ClientSession:
            responses = iter((Response(200, {'available': True}), Response(200, {'success': True, 'data': {}})))
            def __init__(self, **kwargs):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                return False
            def get(self, *args, **kwargs):
                self.testcase.assertFalse(kwargs.get('allow_redirects', True))
                return next(self.responses)
            def post(self, *args, **kwargs):
                self.testcase.assertFalse(kwargs.get('allow_redirects', True))
                return next(self.responses)

        ClientSession.testcase = self
        tools = self.worker.CRMTools(self.ctx, '+919876543210', 'Rahul Shah')
        say = AsyncMock()
        self.worker.aiohttp.ClientSession = ClientSession
        result = await tools.schedule_appointment(
            types.SimpleNamespace(session=types.SimpleNamespace(say=say)),
            date='2099-01-01',
            time='2 PM',
        )
        self.assertIn('database did not confirm', result)
        self.assertIn('पुष्टि नहीं मिली', say.await_args.args[0])

    async def test_booking_confirms_only_after_database_id(self):
        class Response:
            def __init__(self, status, body):
                self.status, self.body = status, body
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                return False
            async def json(self, **kwargs):
                return self.body
            async def text(self):
                return json.dumps(self.body)

        class ClientSession:
            responses = iter((
                Response(200, {'available': True}),
                Response(200, {'success': True, 'data': {'id': 987}}),
            ))
            def __init__(self, **kwargs):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                return False
            def get(self, *args, **kwargs):
                return next(self.responses)
            def post(self, *args, **kwargs):
                return next(self.responses)

        tools = self.worker.CRMTools(self.ctx, '+919876543210', 'Rahul Shah')
        say = AsyncMock()
        self.worker.aiohttp.ClientSession = ClientSession
        result = await tools.schedule_appointment(
            types.SimpleNamespace(session=types.SimpleNamespace(say=say)),
            date='2099-01-01',
            time='2 PM',
        )
        self.assertIn('Saved appointment ID 987', result)
        self.assertIn('बुक हो गई है', say.await_args.args[0])

    async def test_end_call_waits_for_goodbye_and_drains_session(self):
        order = []
        async def playout():
            order.append('played')
        async def say(text, **kwargs):
            order.append('goodbye')
        context = types.SimpleNamespace(wait_for_playout=playout, session=types.SimpleNamespace(
            say=say, shutdown=lambda **kw: order.append(('shutdown', kw))))
        await self.worker.CRMTools(self.ctx).end_call(context)
        self.assertEqual(order, ['played', 'goodbye', ('shutdown', {'drain': True})])

    async def test_browser_transfer_never_selects_a_non_sip_participant(self):
        self.worker.DEFAULT_TRANSFER_NUMBER = '+919000000000'
        self.ctx.room.remote_participants = {'browser': types.SimpleNamespace(kind=0, identity='browser')}
        result = await self.worker.CRMTools(self.ctx, 'browser-call').transfer_call(Mock())
        self.assertIn('only available for telephone', result)


if __name__ == '__main__':
    unittest.main()

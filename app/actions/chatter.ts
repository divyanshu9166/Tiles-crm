'use server'

import { z } from 'zod'
import { prisma } from '@/lib/db'
import { currentActor, actionError } from '@/lib/erp/actor'
import { ACTIVITY_TYPES, CHATTER_MODELS, activityState, logMessage } from '@/lib/erp/chatter'

const recordRef = z.object({ resModel: z.enum(CHATTER_MODELS), resId: z.number().int().positive() })

const noteSchema = recordRef.extend({ body: z.string().trim().min(1, 'Write a note first').max(5000) })

const activitySchema = recordRef.extend({
  resName: z.string().trim().max(200).optional(),
  activityType: z.enum(ACTIVITY_TYPES).default('TODO'),
  summary: z.string().trim().min(1, 'Add a summary').max(200),
  note: z.string().trim().max(2000).optional(),
  dueDate: z.string().min(1, 'Pick a due date'),
  assignedToId: z.number().int().positive().optional(),
})

function fail(error: unknown, fallback: string) {
  return { success: false as const, error: actionError(error, fallback) }
}

function parseDue(value: string) {
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value)
  if (Number.isNaN(date.getTime())) throw new Error('Invalid due date')
  return date
}

export async function getChatter(resModel: string, resId: number) {
  try {
    await currentActor()
    const ref = recordRef.parse({ resModel, resId })
    const [messages, activities] = await Promise.all([
      prisma.recordMessage.findMany({ where: ref, orderBy: { createdAt: 'desc' }, take: 200 }),
      prisma.recordActivity.findMany({
        where: { ...ref, doneAt: null },
        orderBy: { dueDate: 'asc' },
        include: { assignedTo: { select: { id: true, name: true } } },
      }),
    ])
    return {
      success: true as const,
      data: {
        messages,
        activities: activities.map(activity => ({ ...activity, state: activityState(activity.dueDate) })),
      },
    }
  } catch (error) {
    return fail(error, 'Could not load the record history')
  }
}

export async function postNote(data: unknown) {
  try {
    const actor = await currentActor()
    const parsed = noteSchema.parse(data)
    const message = await logMessage(prisma, parsed.resModel, parsed.resId, parsed.body, {
      kind: 'NOTE', author: { id: actor.id, name: actor.name },
    })
    return { success: true as const, data: message }
  } catch (error) {
    return fail(error, 'Could not post the note')
  }
}

export async function scheduleActivity(data: unknown) {
  try {
    const actor = await currentActor()
    const parsed = activitySchema.parse(data)
    if (parsed.assignedToId) {
      const user = await prisma.user.findFirst({ where: { id: parsed.assignedToId, isActive: true }, select: { id: true } })
      if (!user) throw new Error('The selected user is not active')
    }
    const activity = await prisma.recordActivity.create({
      data: {
        resModel: parsed.resModel,
        resId: parsed.resId,
        resName: parsed.resName,
        activityType: parsed.activityType,
        summary: parsed.summary,
        note: parsed.note,
        dueDate: parseDue(parsed.dueDate),
        assignedToId: parsed.assignedToId ?? actor.id,
        createdById: actor.id,
        createdByName: actor.name,
      },
    })
    return { success: true as const, data: activity }
  } catch (error) {
    return fail(error, 'Could not schedule the activity')
  }
}

export async function markActivityDone(id: number, feedback?: string) {
  try {
    const actor = await currentActor()
    const result = await prisma.$transaction(async tx => {
      const done = await tx.recordActivity.updateMany({
        where: { id, doneAt: null },
        data: { doneAt: new Date(), doneByName: actor.name, feedback: feedback?.trim() || null },
      })
      if (done.count !== 1) throw new Error('This activity is already done or no longer exists')
      const activity = await tx.recordActivity.findUniqueOrThrow({ where: { id } })
      if (activity.resModel && (CHATTER_MODELS as readonly string[]).includes(activity.resModel)) {
        const label = ({ TODO: 'To-Do', CALL: 'Call', MEETING: 'Meeting', EMAIL: 'Email', FOLLOW_UP: 'Follow-up', DOCUMENT: 'Document' } as Record<string, string>)[activity.activityType] || 'Activity'
        const body = `${label} done: ${activity.summary}${activity.feedback ? ` — ${activity.feedback}` : ''}`
        await logMessage(tx, activity.resModel as typeof CHATTER_MODELS[number], activity.resId, body, {
          kind: 'SYSTEM', author: { id: actor.id, name: actor.name },
        })
      }
      return activity
    })
    return { success: true as const, data: result }
  } catch (error) {
    return fail(error, 'Could not complete the activity')
  }
}

export async function cancelActivity(id: number) {
  try {
    const actor = await currentActor()
    const activity = await prisma.recordActivity.findUnique({ where: { id } })
    if (!activity || activity.doneAt) throw new Error('This activity is already done or no longer exists')
    const owns = activity.assignedToId === actor.id || activity.createdById === actor.id
    if (!owns && actor.role === 'STAFF') throw new Error('Only the assignee, creator or a manager can cancel this activity')
    await prisma.recordActivity.delete({ where: { id } })
    return { success: true as const }
  } catch (error) {
    return fail(error, 'Could not cancel the activity')
  }
}

// Odoo's activity systray / "My Activities": everything open, grouped by
// overdue / today / planned. Managers can look at the whole team.
export async function getMyActivities(scope: 'mine' | 'team' = 'mine') {
  try {
    const actor = await currentActor()
    const teamView = scope === 'team' && actor.role !== 'STAFF'
    const activities = await prisma.recordActivity.findMany({
      where: { doneAt: null, ...(teamView ? {} : { assignedToId: actor.id }) },
      orderBy: { dueDate: 'asc' },
      take: 500,
      include: { assignedTo: { select: { id: true, name: true } } },
    })
    const rows = activities.map(activity => ({ ...activity, state: activityState(activity.dueDate) }))
    return {
      success: true as const,
      data: {
        rows,
        counts: {
          overdue: rows.filter(row => row.state === 'overdue').length,
          today: rows.filter(row => row.state === 'today').length,
          planned: rows.filter(row => row.state === 'planned').length,
        },
      },
    }
  } catch (error) {
    return fail(error, 'Could not load activities')
  }
}

export async function getActivityBadge() {
  try {
    const actor = await currentActor()
    const endOfToday = new Date()
    endOfToday.setHours(23, 59, 59, 999)
    const due = await prisma.recordActivity.count({ where: { doneAt: null, assignedToId: actor.id, dueDate: { lte: endOfToday } } })
    return { success: true as const, data: { due } }
  } catch {
    return { success: true as const, data: { due: 0 } }
  }
}

export async function getAssignableUsers() {
  try {
    await currentActor()
    const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true, role: true }, orderBy: { name: 'asc' } })
    return { success: true as const, data: users }
  } catch (error) {
    return fail(error, 'Could not load users')
  }
}

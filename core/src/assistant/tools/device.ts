import { z } from 'zod';
import { defineTool, type Tool, type ToolEffect } from './registry.ts';

/**
 * Инструменты телефона: исполняет приложение на iPhone (EventKit, Contacts) по data channel.
 * Здесь только описания и схемы, чтобы модель их видела и чтобы контракт был в одном месте с тестами.
 * Приложение объявляет доступные имена в заголовке X-Device-Tools; необъявленные не попадают в сессию.
 * Контракт (имена, аргументы, ответы) зеркалится в ios/CallAssistant/Services/DeviceTools; менять только парой.
 */
function deviceTool<S extends z.ZodObject>(name: string, effect: ToolEffect, description: string, parameters: S): Tool<S> {
  return defineTool({
    name, effect, description, parameters, runsOn: 'device',
    execute() { throw new Error(`${name} runs on the device, not in the core`); }
  });
}

const isoDate = (what: string) => z.string().describe(`${what}, ISO 8601 with the user's UTC offset, e.g. 2026-09-23T09:00:00+03:00.`);

export const createReminder = deviceTool('create_reminder', 'write',
  'Create a reminder in the user\'s Reminders app. Call when the user asks to remind them of something or to add a to-do.',
  z.object({
    title: z.string().min(1).describe('Short reminder text, in the user\'s words.'),
    due: isoDate('When to remind').nullable().default(null).describe('When to remind, ISO 8601 with offset; null when no time was given.'),
    notes: z.string().nullable().default(null).describe('Extra details, or null.')
  }));

export const listReminders = deviceTool('list_reminders', 'read',
  'List the user\'s open reminders. Call when the user asks what they have to do, what is due today or overdue.',
  z.object({
    scope: z.enum(['today', 'overdue', 'upcoming', 'open']).default('open').describe('today: due today; overdue: past due; upcoming: next 7 days; open: all incomplete.'),
    query: z.string().nullable().default(null).describe('Words to filter by title, or null.')
  }));

export const completeReminder = deviceTool('complete_reminder', 'write',
  'Mark a reminder as completed. Pass the id from list_reminders when known, otherwise a query; several matches are returned as candidates instead of guessing.',
  z.object({
    id: z.string().nullable().default(null).describe('Reminder id from list_reminders, or null.'),
    query: z.string().nullable().default(null).describe('Words from the reminder title when the id is unknown.')
  }));

export const createEvent = deviceTool('create_event', 'write',
  'Create an event in the user\'s Calendar app. Call when the user asks to schedule a meeting, appointment or any timed plan.',
  z.object({
    title: z.string().min(1).describe('Event title.'),
    start: isoDate('Start'),
    end: isoDate('End').nullable().default(null).describe('End, ISO 8601 with offset; null means one hour after start.'),
    allDay: z.boolean().default(false).describe('True for an all-day event; then only the date part of start matters.'),
    location: z.string().nullable().default(null),
    notes: z.string().nullable().default(null)
  }));

export const listEvents = deviceTool('list_events', 'read',
  'List calendar events in a date range. Call when the user asks about their schedule, plans or free time.',
  z.object({
    from: isoDate('Range start').nullable().default(null).describe('Range start, ISO 8601; null means start of today.'),
    to: isoDate('Range end').nullable().default(null).describe('Range end, ISO 8601; null means end of the day of `from`.')
  }));

export const findContact = deviceTool('find_contact', 'read',
  'Look up a person in the user\'s Contacts by name to get their email or phone number. Returns up to three matches.',
  z.object({ name: z.string().min(1).describe('Name or part of a name.') }));

export const deviceTools: readonly Tool[] = [createReminder, listReminders, completeReminder, createEvent, listEvents, findContact];
export const DEVICE_TOOL_NAMES: readonly string[] = deviceTools.map(t => t.name);

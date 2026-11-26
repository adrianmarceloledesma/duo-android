import type { Category, Currency, PersonId } from './domain';

export type DueDateDraft = {
  title: string;
  date: string;
  amount: number | null;
  currency: Currency;
  category?: Category;
  paymentWindowDays?: number;
  remindDaily?: boolean;
};

export type DueDate = DueDateDraft & {
  id: string;
  owner: PersonId;
  paidOn: string | null;
  copiedFrom?: string;
  copiedMonth?: string;
  scheduledDay?: number;
  scheduleId?: string;
  repeatsMonthly?: boolean;
  paymentExpenseIds?: string[];
};

export type DueDateSchedule = {
  id: string;
  owner: PersonId;
  sourceId: string;
  template: DueDateDraft;
  scheduledDay: number;
  startsMonth: string;
  generatedThrough?: string;
};

export type DueDatePayment = {
  date: string;
  expense?: { total: number; sharedAmount: number };
};

export type DueDateChange = {
  kind: 'due-date';
  action:
    | { type: 'save'; id?: string; draft: DueDateDraft }
    | { type: 'paid'; id: string; date: string | null }
    | ({ type: 'pay'; id: string } & DueDatePayment)
    | { type: 'delete'; id: string }
    | { type: 'copy'; month: string; ids: string[]; repeatMonthly?: boolean }
    | { type: 'stop-recurrence'; id: string };
};

const millisecondsPerDay = 86_400_000;

export function paymentWindowDays(from: string, due: string) {
  return (Date.parse(due) - Date.parse(from)) / millisecondsPerDay;
}

export function payableFromDate(due: string, days?: number) {
  return days === undefined ? null : new Date(Date.parse(due) - days * millisecondsPerDay).toISOString().slice(0, 10);
}

export function upcomingDueDateReminders(
  item: Pick<DueDate, 'date' | 'paymentWindowDays' | 'remindDaily'>, now: Date, reminders: boolean, overdue: boolean,
) {
  const [year, month, day] = item.date.split('-').map(Number);
  const timeAt = (offset: number) => new Date(year, month - 1, day + offset, 9).getTime();
  const days = item.paymentWindowDays ?? 0;
  const notices: {
    type: 'due-date-reminder' | 'overdue-due-date'; at: number; title: string; opensPaymentWindow?: boolean;
  }[] = [];

  if (reminders) {
    if (days > 0) {
      notices.push({
        type: 'due-date-reminder', at: timeAt(-days), title: 'Ya podés hacer un pago', opensPaymentWindow: true,
      });
    }
    if (days > 0 && item.remindDaily) {
      const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
      const daysUntilDue = (Date.parse(item.date) - today) / millisecondsPerDay;
      for (let offset = Math.max(1 - days, -daysUntilDue); offset < 0; offset++) {
        notices.push({ type: 'due-date-reminder', at: timeAt(offset), title: 'Recordatorio de pago' });
      }
    }
    notices.push({
      type: 'due-date-reminder', at: timeAt(0), title: 'Un pago vence hoy', opensPaymentWindow: item.paymentWindowDays === 0,
    });
  }

  if (overdue) notices.push({ type: 'overdue-due-date', at: timeAt(1), title: 'Vencimiento atrasado' });
  return notices.filter(notice => notice.at > now.getTime());
}

export function moveDueDateToMonth(date: string, month: string, scheduledDay = Number(date.slice(8, 10))) {
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const day = Math.min(scheduledDay, lastDay);
  return `${month}-${String(day).padStart(2, '0')}`;
}

export function generateDueDateOccurrences(
  schedules: DueDateSchedule[], owner: PersonId, throughMonth: string, makeId: () => string,
) {
  const dueDates: DueDate[] = [];
  const nextSchedules = schedules.map(schedule => {
    if (schedule.owner !== owner || schedule.startsMonth > throughMonth ||
      (schedule.generatedThrough && schedule.generatedThrough >= throughMonth)) return schedule;

    const [year, month] = (schedule.generatedThrough ?? schedule.startsMonth).split('-').map(Number);
    const cursor = new Date(year, month - (schedule.generatedThrough ? 0 : 1), 1, 12);
    for (;;) {
      const monthKey = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
      if (monthKey > throughMonth) break;
      dueDates.push({
        ...schedule.template, id: makeId(), owner, paidOn: null,
        date: moveDueDateToMonth(schedule.template.date, monthKey, schedule.scheduledDay),
        scheduledDay: schedule.scheduledDay, scheduleId: schedule.id, repeatsMonthly: true,
        copiedFrom: schedule.sourceId, copiedMonth: monthKey,
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return { ...schedule, generatedThrough: throughMonth };
  });
  return { dueDates, schedules: nextSchedules };
}

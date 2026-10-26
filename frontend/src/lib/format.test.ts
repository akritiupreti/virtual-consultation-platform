import { describe, expect, it } from 'vitest';
import {
  elapsedSince,
  formatBytes,
  formatDate,
  formatDateTime,
  formatDuration,
  formatTime,
  humanize,
  priorityLabel,
  roleLabel,
  severityLabel,
  shortId,
  stateLabel,
  timeAgo,
} from './format';

describe('display formatting', () => {
  it('turns machine enums into readable labels', () => {
    expect(stateLabel('IN_SESSION')).toBe('In session');
    expect(stateLabel('QUEUED')).toBe('In queue');
    expect(priorityLabel('EMERGENCY')).toBe('Emergency');
    expect(roleLabel('DOCTOR')).toBe('Doctor');
    expect(humanize('MENTAL_HEALTH')).toBe('Mental health');
    expect(humanize('SUMMARY_CHANGES_REQUESTED')).toBe('Summary changes requested');
    expect(humanize(null)).toBe('—');
  });

  it('labels severity with a word', () => {
    expect(severityLabel(3)).toBe('3/5 · Moderate');
    expect(severityLabel(9)).toBe('9/5');
  });

  it('formats durations for wait times', () => {
    expect(formatDuration(20)).toBe('just now');
    expect(formatDuration(12 * 60)).toBe('12 min');
    expect(formatDuration(60 * 60)).toBe('1 h');
    expect(formatDuration(65 * 60)).toBe('1 h 5 min');
    expect(formatDuration(27 * 3600)).toBe('1 d 3 h');
    expect(formatDuration(48 * 3600)).toBe('2 d');
    expect(formatDuration(-5)).toBe('just now');
  });

  it('measures elapsed time from a timestamp', () => {
    const now = Date.parse('2026-10-22T10:00:00.000Z');
    expect(elapsedSince('2026-10-22T09:48:00.000Z', now)).toBe('12 min');
    expect(timeAgo('2026-10-22T09:48:00.000Z', now)).toBe('12 min ago');
    expect(timeAgo('2026-10-22T09:59:40.000Z', now)).toBe('just now');
    expect(elapsedSince(null, now)).toBe('—');
    expect(elapsedSince('not a date', now)).toBe('—');
  });

  it('renders dates defensively', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('garbage')).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatTime(null)).toBe('');
    expect(formatDateTime('2026-10-22T09:00:00.000Z')).toMatch(/2026/);
    expect(formatDate('2026-10-22T09:00:00.000Z')).toMatch(/2026/);
    expect(formatTime('2026-10-22T09:00:00.000Z')).not.toBe('');
  });

  it('formats file sizes and short ids', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(shortId('0123456789abcdef')).toBe('01234567');
    expect(shortId(null)).toBe('—');
  });
});

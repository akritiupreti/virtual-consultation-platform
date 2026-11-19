import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disconnectRealtime,
  getRealtimeSocket,
  useConsultationRoom,
  usePatientUpdates,
  useQueueUpdates,
} from './realtime';

// A fake socket that records event handlers so tests can fire them and cover
// the inner callbacks the hooks register.
const handlers = vi.hoisted(() => new Map<string, (payload?: unknown) => void>());
const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: vi.fn((event: string, cb: (payload?: unknown) => void) => handlers.set(event, cb)),
  off: vi.fn(),
  emit: vi.fn(),
  disconnect: vi.fn(),
}));
const io = vi.hoisted(() => vi.fn(() => fakeSocket));
vi.mock('socket.io-client', () => ({ io }));

describe('realtime socket', () => {
  beforeEach(() => {
    localStorage.clear();
    handlers.clear();
    fakeSocket.on.mockClear();
    fakeSocket.off.mockClear();
    fakeSocket.emit.mockClear();
    fakeSocket.disconnect.mockClear();
    fakeSocket.connected = true;
    disconnectRealtime();
    io.mockClear();
  });
  afterEach(() => disconnectRealtime());

  it('returns null without a token', () => {
    expect(getRealtimeSocket()).toBeNull();
    expect(io).not.toHaveBeenCalled();
  });

  it('creates one shared socket once a token exists and reuses it', () => {
    localStorage.setItem('vcp_token', 'tok');
    const first = getRealtimeSocket();
    const second = getRealtimeSocket();
    expect(first).toBe(second);
    expect(io).toHaveBeenCalledTimes(1);
  });

  it('replaces the socket when the token changes', () => {
    localStorage.setItem('vcp_token', 'tok-1');
    getRealtimeSocket();
    localStorage.setItem('vcp_token', 'tok-2');
    getRealtimeSocket();
    expect(fakeSocket.disconnect).toHaveBeenCalled();
    expect(io).toHaveBeenCalledTimes(2);
  });

  it('disconnects on teardown', () => {
    localStorage.setItem('vcp_token', 'tok');
    getRealtimeSocket();
    disconnectRealtime();
    expect(fakeSocket.disconnect).toHaveBeenCalled();
  });

  it('useQueueUpdates subscribes, fires onChange and cleans up', () => {
    localStorage.setItem('vcp_token', 'tok');
    const onChange = vi.fn();
    const { unmount } = renderHook(() => useQueueUpdates(onChange));
    expect(fakeSocket.emit).toHaveBeenCalledWith('subscribe:queue');
    handlers.get('queue:updated')?.();
    expect(onChange).toHaveBeenCalled();
    // A reconnect re-subscribes.
    handlers.get('connect')?.();
    expect(fakeSocket.emit).toHaveBeenCalledWith('subscribe:queue');
    unmount();
    expect(fakeSocket.off).toHaveBeenCalledWith('queue:updated', expect.any(Function));
  });

  it('usePatientUpdates re-fetches on position and consultation pushes', () => {
    localStorage.setItem('vcp_token', 'tok');
    const onChange = vi.fn();
    const { unmount } = renderHook(() => usePatientUpdates(onChange));
    handlers.get('position:updated')?.();
    handlers.get('consultation:updated')?.();
    expect(onChange).toHaveBeenCalledTimes(2);
    unmount();
    expect(fakeSocket.off).toHaveBeenCalledWith('position:updated', expect.any(Function));
  });

  it('useConsultationRoom joins, routes room events and leaves on unmount', () => {
    localStorage.setItem('vcp_token', 'tok');
    const onMessage = vi.fn();
    const onConsultationUpdated = vi.fn();
    const { unmount } = renderHook(() =>
      useConsultationRoom('c-1', { onMessage, onConsultationUpdated }),
    );
    expect(fakeSocket.emit).toHaveBeenCalledWith('join:consultation', { consultationId: 'c-1' });
    handlers.get('message:created')?.({ message: { id: 'm-1' } });
    handlers.get('consultation:updated')?.();
    expect(onMessage).toHaveBeenCalledWith({ id: 'm-1' });
    expect(onConsultationUpdated).toHaveBeenCalled();
    unmount();
    expect(fakeSocket.emit).toHaveBeenCalledWith('leave:consultation', { consultationId: 'c-1' });
  });

  it('hooks no-op without a socket (no token)', () => {
    const onChange = vi.fn();
    expect(() => renderHook(() => useQueueUpdates(onChange))).not.toThrow();
    expect(fakeSocket.on).not.toHaveBeenCalled();
  });
});

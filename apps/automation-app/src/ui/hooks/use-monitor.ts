import { useCallback, useEffect, useRef, useState } from 'react';

/** Poll read-only JSON; React preserves focused controls and expanded records. */
export function useMonitor<T>(url: string, initial: T) {
  const [data, setData] = useState(initial);
  const [auto, setAuto] = useState(true);
  const [message, setMessage] = useState('自動更新を待っています。');
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const response = await fetch(url, { credentials: 'same-origin',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
      if (!response.ok) throw new Error(String(response.status));
      const next = await response.json() as T;
      if (!controller.signal.aborted) {
        setData(next);
        setMessage(`取得時刻 ${new Date().toLocaleTimeString('ja-JP')} · 表示を更新しました`);
      }
    } catch {
      if (!controller.signal.aborted) setMessage('更新できませんでした。表示は前回の取得結果です。');
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [url]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(async () => {
        if (auto && document.visibilityState !== 'hidden') await refresh();
        if (!stopped) schedule();
      }, 5_000);
    };
    schedule();
    return () => { stopped = true; clearTimeout(timer); };
  }, [auto, refresh]);
  useEffect(() => () => { request.current?.abort(); }, [url]);
  return { data, auto, setAuto, message, busy, refresh };
}

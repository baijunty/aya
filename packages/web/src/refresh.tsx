// 全局自动刷新节拍：所有页面共用一个时钟，顶栏可见、可暂停、可切档。
// 设计要点：
//  - 节拍由 Provider 单点驱动（tick 自增），页面里的 usePoll 只订阅 tick，不再各起一个定时器；
//  - 标签页切到后台时不刷新（浏览器本就节流定时器，且此时没人看），切回前台立即补一次；
//  - 档位与手动刷新都只改 tick，因此「时间窗」等派生状态能在同一次渲染里跟着走，
//    不会出现 tick 与 from/to 分两次提交导致的重复请求。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export const REFRESH_OPTIONS: Array<{ label: string; ms: number; title: string }> = [
  { label: '5s', ms: 5_000, title: '每 5 秒刷新（盯后端启停时用）' },
  { label: '10s', ms: 10_000, title: '每 10 秒刷新（默认）' },
  { label: '30s', ms: 30_000, title: '每 30 秒刷新' },
  { label: '60s', ms: 60_000, title: '每 60 秒刷新' },
  { label: '关', ms: 0, title: '暂停自动刷新，只手动刷新' },
];

const DEFAULT_MS = 10_000;
const LS_KEY = 'aya.refresh-ms';

function loadIntervalMs(): number {
  const raw = localStorage.getItem(LS_KEY);
  // 注意区分「没存过」和「存了 0（关）」：Number(null) 也是 0，直接 Number() 会让首次访问默认暂停
  if (raw === null) return DEFAULT_MS;
  const ms = Number(raw);
  return REFRESH_OPTIONS.some((o) => o.ms === ms) ? ms : DEFAULT_MS;
}

/** 页面是否在前台：后台时暂停轮询 */
export function isPageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

interface RefreshState {
  /** 0 = 已暂停自动刷新 */
  intervalMs: number;
  setIntervalMs: (ms: number) => void;
  /** 每次节拍 / 手动刷新 +1：跟随全局节拍的 usePoll 由此重新拉取 */
  tick: number;
  /** 最近一次刷新发起的时刻（epoch ms） */
  lastTickAt: number;
  refreshNow: () => void;
}

const RefreshCtx = createContext<RefreshState>({
  intervalMs: DEFAULT_MS,
  setIntervalMs: () => undefined,
  tick: 0,
  lastTickAt: 0,
  refreshNow: () => undefined,
});

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [intervalMs, setIntervalMsState] = useState(loadIntervalMs);
  const [tick, setTick] = useState(0);
  const [lastTickAt, setLastTickAt] = useState(() => Date.now());

  const fire = useCallback(() => {
    setTick((t) => t + 1);
    setLastTickAt(Date.now());
  }, []);

  const setIntervalMs = useCallback(
    (ms: number) => {
      localStorage.setItem(LS_KEY, String(ms));
      setIntervalMsState(ms);
      // 切档立即刷一次，否则最长要等一个完整周期才看得到效果
      if (ms > 0) fire();
    },
    [fire],
  );

  useEffect(() => {
    if (!intervalMs) return;
    const t = setInterval(() => {
      if (isPageVisible()) fire();
    }, intervalMs);
    // 后台期间定时器被节流，回到前台先补一次，避免停在旧数据上
    const onVis = () => {
      if (isPageVisible()) fire();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [intervalMs, fire]);

  const value = useMemo(
    () => ({ intervalMs, setIntervalMs, tick, lastTickAt, refreshNow: fire }),
    [intervalMs, setIntervalMs, tick, lastTickAt, fire],
  );
  return <RefreshCtx.Provider value={value}>{children}</RefreshCtx.Provider>;
}

export function useRefresh() {
  return useContext(RefreshCtx);
}

export interface PollResult<T> {
  data: T | undefined;
  error: string | undefined;
  /** 有一次拉取在途（旧数据仍然展示，不会闪成空白） */
  refreshing: boolean;
  /** 最近一次拉取成功的时刻，用于「更新于」 */
  updatedAt: number | undefined;
  reload: () => void;
}

/**
 * 数据轮询。
 * @param fn 拉取函数（每次调用取最新闭包，不会被定时器捕获成旧 state）
 * @param deps 影响请求的参数；变化即重新拉取
 * @param intervalMs 省略 = 跟随顶栏全局节拍（含暂停）；传数字 = 本页自己的周期（如详情弹窗 60s、音色 30s）
 */
export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], intervalMs?: number): PollResult<T> {
  const { tick: globalTick } = useRefresh();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [localTick, setLocalTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const followGlobal = intervalMs === undefined;

  useEffect(() => {
    // alive 属于本次 effect 实例：deps 变化后旧请求的迟到结果被丢弃，不会覆盖新数据
    let alive = true;
    setRefreshing(true);
    fnRef
      .current()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(undefined);
        setUpdatedAt(Date.now());
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setRefreshing(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, globalTick, localTick]);

  useEffect(() => {
    if (followGlobal || !intervalMs) return;
    const t = setInterval(() => {
      if (isPageVisible()) setLocalTick((x) => x + 1);
    }, intervalMs);
    return () => clearInterval(t);
  }, [followGlobal, intervalMs]);

  return { data, error, refreshing, updatedAt, reload: () => setLocalTick((x) => x + 1) };
}

/** 每 intervalMs 返回当前时刻：把两次轮询之间的倒计时/运行时长补成连续走动 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

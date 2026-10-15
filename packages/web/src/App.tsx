import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Overview } from './pages/Overview';
import { Trends } from './pages/Trends';
import { Requests } from './pages/Requests';
import { Backends } from './pages/Backends';
import { Voices } from './pages/Voices';
import { Login } from './pages/Login';
import { api, AUTH_EXPIRED_EVENT } from './api';

type Page = 'overview' | 'trends' | 'requests' | 'backends' | 'voices';

const RangeCtx = createContext<{ from: number; to: number; setRange: (d: number) => void }>({
  from: 0,
  to: 0,
  setRange: () => undefined,
});

const RANGES = [
  { label: '今日', days: 0 },
  { label: '近 7 天', days: 7 },
  { label: '近 30 天', days: 30 },
];

function computeRange(days: number): { from: number; to: number } {
  const now = Date.now();
  if (days === 0) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return { from: d.getTime(), to: now };
  }
  return { from: now - days * 86400_000, to: now };
}

export function App() {
  const [page, setPage] = useState<Page>(() => (location.hash.slice(1) as Page) || 'overview');
  const [days, setDays] = useState(7);
  const [range, setRange] = useState(() => computeRange(7));
  // 登录态：undefined = 探测中；{ui_auth:false} = 服务端未启用登录；
  // {ui_auth:true, user:null} = 需登录；{ui_auth:true, user:'x'} = 已登录
  const [authState, setAuthState] = useState<{ ui_auth: boolean; user: string | null } | undefined>(undefined);

  useEffect(() => {
    api
      .authMe()
      .then((me) => setAuthState({ ui_auth: me.ui_auth, user: me.user }))
      // 401 = 服务端启用了登录且会话缺失/过期 → 显示登录页；其余错误按未启用放行
      .catch((e: Error) => setAuthState(e.message.startsWith('401') ? { ui_auth: true, user: null } : { ui_auth: false, user: null }));
    const onExpired = () => setAuthState((s) => (s ? { ...s, user: null } : s));
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const logout = useCallback(() => {
    void api.logout().catch(() => undefined);
    setAuthState((s) => (s ? { ...s, user: null } : s));
  }, []);

  useEffect(() => {
    const onHash = () => setPage((location.hash.slice(1) as Page) || 'overview');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    setRange(computeRange(days));
    const t = setInterval(() => setRange(computeRange(days)), 10000);
    return () => clearInterval(t);
  }, [days]);

  const nav: Array<[Page, string]> = [
    ['overview', '总览'],
    ['trends', '趋势'],
    ['requests', '请求明细'],
    ['backends', '后端状态'],
    ['voices', '自定义音色'],
  ];

  if (authState === undefined) return null; // 探测登录态中
  if (authState.ui_auth && !authState.user) {
    return <Login onLoggedIn={(u) => setAuthState({ ui_auth: true, user: u })} />;
  }

  return (
    <RangeCtx.Provider value={{ ...range, setRange: (d) => setDays(d) }}>
      <div className="layout">
        <aside className="sidebar">
          <div className="logo">
            Aya<span> 控制台</span>
          </div>
          <nav>
            {nav.map(([p, label]) => (
              <a key={p} href={`#${p}`} className={page === p ? 'active' : ''} onClick={() => setPage(p)}>
                {label}
              </a>
            ))}
          </nav>
        </aside>
        <main className="main">
          <div className="topbar">
            <h2 style={{ margin: 0 }}>{nav.find(([p]) => p === page)?.[1]}</h2>
            <div className="ranges">
              {page !== 'voices' &&
                RANGES.map((r) => (
                  <button key={r.days} className={days === r.days ? 'active' : ''} onClick={() => setDays(r.days)}>
                    {r.label}
                  </button>
                ))}
              {authState.user && (
                <span className="user-chip" title={`已登录：${authState.user}`}>
                  {authState.user}
                  <button className="btn logout-btn" onClick={logout}>
                    退出
                  </button>
                </span>
              )}
            </div>
          </div>
          {page === 'overview' && <Overview />}
          {page === 'trends' && <Trends />}
          {page === 'requests' && <Requests />}
          {page === 'backends' && <Backends />}
          {page === 'voices' && <Voices />}
        </main>
      </div>
    </RangeCtx.Provider>
  );
}

export function useRange() {
  return useContext(RangeCtx);
}

/** 轮询 hook */
export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], intervalMs = 10000): { data: T | undefined; error: string | undefined; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fn()
      .then((d) => {
        if (alive) {
          setData(d);
          setError(undefined);
        }
      })
      .catch((e: Error) => alive && setError(e.message));
    const t = setInterval(() => {
      fn()
        .then((d) => alive && (setData(d), setError(undefined)))
        .catch((e: Error) => alive && setError(e.message));
    }, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((x) => x + 1) };
}

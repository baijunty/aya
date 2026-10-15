import { useState } from 'react';
import { api } from '../api';

/** 看板登录页（server.ui_auth 配置后显示） */
export function Login({ onLoggedIn }: { onLoggedIn: (user: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.login(username, password);
      onLoggedIn(r.user);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      setError(msg.includes('401') ? '用户名或密码错误' : msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="logo">
          Aya<span> 控制台</span>
        </div>
        <p className="login-sub">请登录以查看统计看板</p>
        <label>
          用户名
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            placeholder="username"
          />
        </label>
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            placeholder="••••••"
          />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button className="btn login-btn" type="submit" disabled={busy || !username || !password}>
          {busy ? '登录中…' : '登 录'}
        </button>
      </form>
    </div>
  );
}

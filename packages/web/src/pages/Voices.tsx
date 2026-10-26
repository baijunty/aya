import { useRef, useState } from 'react';
import { api, type Voice } from '../api';
import { usePoll } from '../refresh';
import { fmtBytes, fmtDateTime } from '../format';

export function Voices() {
  const { data, error, reload } = usePoll(() => api.voices(), [], 30000);
  const [name, setName] = useState('');
  const [consent, setConsent] = useState('');
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async () => {
    if (!name.trim()) return setMsg('请填写音色名称');
    if (!file) return setMsg('请选择参考音频文件');
    setBusy(true);
    setMsg(undefined);
    try {
      const v = await api.uploadVoice(name.trim(), file, consent.trim() || undefined);
      setMsg(`已创建音色 ${v.id}`);
      setName('');
      setConsent('');
      setFile(undefined);
      if (fileRef.current) fileRef.current.value = '';
      reload();
    } catch (e) {
      setMsg(`上传失败：${(e as Error).message}`);
    }
    setBusy(false);
  };

  const rename = async (v: Voice) => {
    const nn = window.prompt('新的音色名称', v.name);
    if (!nn?.trim() || nn === v.name) return;
    try {
      await api.renameVoice(v.id, nn.trim());
      reload();
    } catch (e) {
      alert(String((e as Error).message));
    }
  };

  const remove = async (v: Voice) => {
    if (!window.confirm(`删除音色 "${v.name}"（${v.id}）？样本文件将一并删除。`)) return;
    try {
      await api.deleteVoice(v.id);
      reload();
    } catch (e) {
      alert(String((e as Error).message));
    }
  };

  return (
    <div>
      <div className="panel">
        <h3>上传自定义音色</h3>
        <div className="bar-row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <input type="text" placeholder="音色名称（speech 请求 voice 参数用）" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 260 }} />
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.webm"
            onChange={(e) => setFile(e.target.files?.[0])}
          />
          <input type="text" placeholder="consent（可选）" value={consent} onChange={(e) => setConsent(e.target.value)} style={{ width: 160 }} />
          <button className="btn" disabled={busy} onClick={upload}>
            {busy ? '上传中…' : '上传'}
          </button>
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          上传参考音频样本（建议 3~10 秒清晰人声 wav/mp3）。合成时调用
          <code> /v1/audio/speech </code>并在 <code>voice</code> 参数传音色 id 或名称即可克隆该音色。
        </div>
        {msg && <div style={{ marginTop: 8, color: msg.startsWith('上传失败') ? 'var(--red)' : 'var(--green)' }}>{msg}</div>}
      </div>

      {error && <div className="err">加载失败：{error}</div>}
      <div className="panel">
        <h3>音色列表</h3>
        <table>
          <thead>
            <tr>
              <th>名称</th><th>ID</th><th>创建时间</th><th>大小</th><th>试听</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {(data?.data ?? []).map((v) => (
              <tr key={v.id}>
                <td><b>{v.name}</b></td>
                <td className="muted">{v.id}</td>
                <td className="muted">{fmtDateTime(v.created_at * 1000)}</td>
                <td className="muted">{fmtBytes(v.metadata?.bytes)}</td>
                <td>
                  <audio controls preload="none" src={api.voiceSampleUrl(v.id)} style={{ height: 30, maxWidth: 260 }} />
                </td>
                <td>
                  <button className="btn" onClick={() => rename(v)}>改名</button>{' '}
                  <button className="btn danger" onClick={() => remove(v)}>删除</button>
                </td>
              </tr>
            ))}
            {data && data.data.length === 0 && (
              <tr><td colSpan={6} className="muted">暂无音色，上传一段参考音频开始使用自定义音色。</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

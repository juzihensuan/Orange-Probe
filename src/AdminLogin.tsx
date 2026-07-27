import { Activity, ArrowLeft, Eye, EyeOff, LoaderCircle, LockKeyhole, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { showFirewallBlockedPage } from "./firewall";

export interface AdminSession {
  authenticated: true;
  username: string;
  expiresAt: number;
}

export default function AdminLogin({ onLogin }: { onLogin: (session: AdminSession) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { document.title = "Orange Probe · 后台登录"; }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const payload = await response.json().catch(() => ({})) as Partial<AdminSession> & { error?: string; blocked?: boolean; ip?: string; remainingAttempts?: number };
      if (!response.ok) {
        if (payload.blocked) {
          showFirewallBlockedPage(payload.ip);
          return;
        }
        const remainingAttempts = Math.max(0, Math.min(4, Number(payload.remainingAttempts) || 0));
        throw new Error(payload.error === "Invalid username or password" ? `用户名或密码错误，剩余 ${remainingAttempts} 次尝试机会` : payload.error || "登录失败");
      }
      onLogin(payload as AdminSession);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "登录失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="admin-login-page">
      <a className="admin-back-home" href="/"><ArrowLeft size={15} />返回公开状态页</a>
      <section className="admin-login-panel">
        <div className="admin-login-brand"><span><Activity size={20} /></span><strong>Orange</strong><b>Probe</b></div>
        <div className="admin-login-copy"><span><LockKeyhole size={20} /></span><div><h1>管理后台</h1><p>登录后管理 Agent、阈值和告警</p></div></div>
        <form onSubmit={submit}>
          <label><span>用户名</span><div><UserRound size={16} /><input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="管理员账号" required /></div></label>
          <label><span>密码</span><div><LockKeyhole size={16} /><input type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="管理员密码" required /><button type="button" onClick={() => setShowPassword((value) => !value)} title={showPassword ? "隐藏密码" : "显示密码"}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
          {error && <p className="admin-login-error">{error}</p>}
          <button className="admin-login-submit" disabled={loading}>{loading ? <LoaderCircle className="spin" size={16} /> : <LockKeyhole size={16} />}登录后台</button>
        </form>
        <small>会话将在 12 小时后自动过期</small>
      </section>
    </main>
  );
}

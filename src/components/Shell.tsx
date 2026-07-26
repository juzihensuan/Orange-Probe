import {
  Activity,
  BellRing,
  Gauge,
  LogOut,
  Menu,
  Moon,
  Network,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldBan,
  Sun,
  UserRound,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import type { ViewName } from "../types";

const navItems: Array<{ id: ViewName; label: string; icon: typeof Gauge }> = [
  { id: "overview", label: "运行概览", icon: Gauge },
  { id: "serviceOverview", label: "服务概览", icon: Activity },
  { id: "servers", label: "节点管理", icon: Server },
  { id: "network", label: "服务监控", icon: Network },
  { id: "events", label: "事件告警", icon: BellRing },
  { id: "firewall", label: "防火墙", icon: ShieldBan },
  { id: "updates", label: "系统更新", icon: RefreshCw },
  { id: "settings", label: "监控设置", icon: Settings },
];

const pageTitles: Record<ViewName, { title: string; subtitle: string }> = {
  overview: { title: "运行概览", subtitle: "全部基础设施的实时状态" },
  serviceOverview: { title: "服务概览", subtitle: "查看节点 CPU、内存、磁盘和网络的 7 天历史" },
  servers: { title: "节点管理", subtitle: "编辑节点标识、计费、到期与续费设置" },
  network: { title: "服务监控", subtitle: "配置 HTTP、Ping 和 TCPing 任务" },
  events: { title: "事件告警", subtitle: "需要处理的异常与状态变化" },
  firewall: { title: "防火墙", subtitle: "管理登录保护与被封禁的访问 IP" },
  updates: { title: "系统更新", subtitle: "更新服务端、Docker 镜像与远程 Agent" },
  settings: { title: "监控设置", subtitle: "阈值、Telegram 通知与采集配置" },
};

interface ShellProps {
  view: ViewName;
  onViewChange: (view: ViewName) => void;
  children: ReactNode;
  dark: boolean;
  onThemeToggle: () => void;
  connected: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onAddProbe: () => void;
  mobileOpen: boolean;
  onMobileOpenChange: (value: boolean) => void;
  adminUsername: string;
  onLogout: () => void;
}

function Brand() {
  return (
    <div className="brand" aria-label="Orange Probe">
      <span className="brand-mark"><Activity size={18} strokeWidth={2.6} /></span>
      <span>
        <strong>Orange</strong>
        <b>Probe</b>
      </span>
    </div>
  );
}

function Navigation({
  view,
  onViewChange,
}: Pick<ShellProps, "view" | "onViewChange">) {
  return (
    <nav className="nav-list" aria-label="主导航">
      <span className="nav-caption">监控中心</span>
      {navItems.map((item) => {
        const Icon = item.icon;
        return (
          <button
            className={view === item.id ? "nav-item active" : "nav-item"}
            key={item.id}
            onClick={() => onViewChange(item.id)}
          >
            <Icon size={18} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

export default function Shell(props: ShellProps) {
  const page = pageTitles[props.view];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <Navigation view={props.view} onViewChange={props.onViewChange} />
        <div className="sidebar-foot">
          <div className="admin-session-row">
            <span><UserRound size={15} /></span>
            <div><b>{props.adminUsername}</b><small>后台管理员</small></div>
            <button onClick={props.onLogout} title="退出后台"><LogOut size={15} /></button>
          </div>
          <div className="collector-state">
            <span className={props.connected ? "status-dot online" : "status-dot offline"} />
            <span><b>{props.connected ? "实时连接正常" : "正在重新连接"}</b><small>WebSocket 采集通道</small></span>
          </div>
          <span className="version">Orange Probe v1.1.3</span>
        </div>
      </aside>

      {props.mobileOpen && (
        <div className="mobile-panel">
          <button className="mobile-scrim" onClick={() => props.onMobileOpenChange(false)} aria-label="关闭导航" />
          <aside className="mobile-drawer">
            <div className="mobile-drawer-head">
              <Brand />
              <button className="icon-button" onClick={() => props.onMobileOpenChange(false)} title="关闭">
                <X size={19} />
              </button>
            </div>
            <Navigation
              view={props.view}
              onViewChange={(next) => {
                props.onViewChange(next);
                props.onMobileOpenChange(false);
              }}
            />
            <div className="mobile-admin-session"><span><UserRound size={16} />{props.adminUsername}</span><button onClick={props.onLogout}><LogOut size={15} />退出</button></div>
          </aside>
        </div>
      )}

      <main className="main-area">
        <header className="topbar">
          <div className="page-heading">
            <button className="icon-button mobile-menu" onClick={() => props.onMobileOpenChange(true)} title="菜单">
              <Menu size={20} />
            </button>
            <span><h1>{page.title}</h1><p>{page.subtitle}</p></span>
          </div>
          <div className="topbar-actions">
            <label className="search-box">
              <Search size={16} />
              <input
                value={props.search}
                onChange={(event) => props.onSearchChange(event.target.value)}
                placeholder="搜索节点、地区或标签"
                aria-label="搜索服务器"
              />
              {props.search && <button onClick={() => props.onSearchChange("")} title="清空搜索"><X size={14} /></button>}
            </label>
            <button className="icon-button" onClick={props.onThemeToggle} title={props.dark ? "切换浅色模式" : "切换深色模式"}>
              {props.dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button className="primary-button add-probe" onClick={props.onAddProbe}>
              <Plus size={17} />
              <span>添加 Agent</span>
            </button>
          </div>
        </header>
        <div className="page-content">{props.children}</div>
      </main>
    </div>
  );
}

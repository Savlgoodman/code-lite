import "./OverviewPage.css";

export function OverviewPage() {
  return (
    <main className="main-panel overview-panel">
      <div className="overview-wip">
        <div className="overview-wip-icon"></div>
        <h1 className="overview-wip-title">正在施工</h1>
        <p className="overview-wip-desc">这个页面还在建设中，敬请期待。</p>
      </div>
    </main>
  );
}

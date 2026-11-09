export const stylesheet = `
:root {
    color-scheme: light;
    --bg: #72b6e8;
    --panel: #eff3f9;
    --line: #8da9c5;
    --text: #172b43;
    --muted: #4e647b;
    --orange: #c75b0a;
    --green: #287a35;
    --light-blue: #147ca8;
    font-family: "Segoe UI", system-ui, sans-serif;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
    margin: 0;
    background: linear-gradient(180deg, #4f9fe0 0%, #b9e2ff 55%, #77b96f 100%) fixed;
    color: var(--text);
    min-height: 100vh;
    line-height: 1.65;
}
body::before {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    background: radial-gradient(ellipse at 50% 70%, #ffffff20 0, transparent 55%);
    z-index: -1;
}
a { color: var(--light-blue); text-underline-offset: 4px; }
a:hover { color: white; }
:focus-visible { outline: 3px solid var(--orange); outline-offset: 5px; }
.skip-link { position: absolute; left: 24px; top: -100px; z-index: 3; background: var(--panel); padding: 12px; }
.skip-link:focus { top: 12px; }
.topbar {
    min-height: 88px;
    border-bottom: 1px solid #174b93;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 16px max(24px, calc((100vw - 1320px) / 2));
    background: linear-gradient(180deg, #67b4ff 0%, #2676d2 48%, #0755b5 100%);
    box-shadow: inset 0 1px #b5dcff, 0 2px 5px #163c6a66;
}
.brand { display: flex; align-items: center; gap: 13px; color: white; text-decoration: none; text-shadow: 0 1px #174b93; }
.brand-mark {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border: 1px solid #b8dcff;
    border-radius: 8px;
    color: #fff1d9;
    background: linear-gradient(145deg, #ffbd66, #dd6b16 68%, #b64b0b);
    box-shadow: inset 1px 1px #ffe4b9, 0 1px 3px #153d70;
    font-size: 28px;
    font-weight: 300;
}
.brand strong { display: block; letter-spacing: .16em; font-size: 14px; }
.brand small { display: block; color: #e0efff; font-size: 11px; letter-spacing: .1em; }
.topbar nav { display: flex; gap: 24px; align-items: center; font-size: 13px; }
.topbar nav a { color: #eef7ff; text-decoration: none; text-shadow: 0 1px #174b93; }
.topbar nav a:hover { color: #ffe2bd; }
.protocol { border: 1px solid #a8d1ff; padding: 5px 12px; border-radius: 5px; color: #fff; background: #0755b566; font-size: 11px; letter-spacing: .1em; }
main { max-width: 1368px; margin: auto; padding: 48px 24px 64px; }
.page-heading { display: flex; justify-content: space-between; align-items: end; gap: 20px; margin-bottom: 32px; }
.eyebrow { color: var(--orange); text-transform: uppercase; letter-spacing: .19em; font-size: 11px; font-weight: 600; }
h1 { margin: 6px 0 0; font-size: clamp(28px, 4vw, 46px); line-height: 1.2; letter-spacing: -.045em; font-weight: 600; }
h2 { font-size: 20px; letter-spacing: -.025em; margin: 0 0 20px; font-weight: 600; }
h3 { font-size: 14px; font-weight: 600; margin: 24px 0 12px; }
p { color: var(--muted); }
.section-number { color: var(--green); font-size: 12px; letter-spacing: .15em; margin-right: 10px; }
.panel {
    background: linear-gradient(180deg, #fff 0%, #f5f7fb 14%, #e6ecf5 100%);
    border: 1px solid #6889ad;
    border-radius: 8px;
    padding: 28px;
    box-shadow: inset 1px 1px #fff, inset -1px -1px #c5d1df, 0 3px 8px #214a7550;
    min-width: 0;
}
.workspace { display: grid; grid-template-columns: minmax(260px, .75fr) minmax(0, 1.6fr); gap: 24px; align-items: start; }
.context-column { display: grid; gap: 24px; min-width: 0; }
.patient-heading { border-bottom: 1px solid var(--line); padding-bottom: 24px; margin-bottom: 24px; }
.avatar { width: 54px; height: 54px; display: grid; place-items: center; border-radius: 8px; background: linear-gradient(145deg, #dbf0ff, #b6dcf6); color: var(--green); border: 1px solid #79a8ce; box-shadow: inset 1px 1px white; margin-bottom: 18px; font-size: 18px; }
.patient-name { font-size: 25px; margin: 8px 0; overflow-wrap: anywhere; }
.badge { display: inline-flex; gap: 8px; align-items: center; font-size: 12px; padding: 4px 11px; border: 1px solid #70a579; border-radius: 5px; color: #21662d; background: linear-gradient(#f5fff4, #dcefd9); }
.badge::before { content: ""; width: 6px; height: 6px; background: currentColor; border-radius: 50%; }
dl { margin: 0; display: grid; gap: 16px; }
.context-field { display: grid; gap: 3px; }
dt { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .09em; }
dd { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.scope-text { font-family: Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; padding: 12px; border: 1px solid #aabbd0; background: #fff; border-radius: 4px; box-shadow: inset 1px 1px 2px #b9c6d5; }
.scope-label { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); }
.clinical-header { display: flex; justify-content: space-between; gap: 16px; align-items: center; flex-wrap: wrap; }
.clinical-header h2 { margin: 0; }
.clinical-header + h3 { margin-top: 28px; }
.diagnoses, .readings { list-style: none; padding: 0; margin: 0; }
.diagnoses li { padding: 14px 16px; background: linear-gradient(90deg, #e5f4e3, #f8fbf7); border: 1px solid #a5c4a4; border-left: 4px solid var(--green); border-radius: 4px; font-size: 13px; overflow-wrap: anywhere; }
.diagnoses li + li { margin-top: 8px; }
.temperature-stat { display: flex; justify-content: space-between; align-items: end; gap: 16px; margin: 26px 0 12px; }
.temperature-stat h3 { margin: 0 0 6px; }
.temperature-value { font-size: clamp(24px, 3vw, 36px); letter-spacing: -.04em; font-weight: 600; }
.temperature-value small { font-size: 13px; color: var(--muted); letter-spacing: 0; font-weight: 400; }
.reading-count { font-size: 11px; color: var(--muted); text-align: right; }
figure { margin: 20px 0; padding: 20px 14px 10px; background: linear-gradient(#e9f5ff, #f8fbff); border: 1px solid #93b4d2; border-radius: 5px; box-shadow: inset 1px 1px white; }
figcaption { font-size: 11px; color: var(--muted); margin: 0 0 16px 8px; letter-spacing: .04em; }
.trend-chart { display: block; height: auto; color: var(--muted); }
.chart-axis, .chart-grid { stroke: var(--line); }
.chart-grid { stroke-dasharray: 4 6; }
.chart-label { fill: currentColor; font-family: inherit; }
.chart-line { stroke: var(--orange); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
.chart-marker { fill: var(--panel); stroke: var(--orange); stroke-width: 2; }
.chart-area { fill: #c75b0a18; }
details { border-top: 1px solid var(--line); margin-top: 18px; padding-top: 16px; }
summary { cursor: pointer; color: var(--muted); font-size: 13px; }
summary:hover { color: var(--light-blue); }
.readings li { padding: 16px 0; border-bottom: 1px solid var(--line); font-size: 12px; overflow-wrap: anywhere; color: var(--muted); }
.readings strong { color: var(--text); font-weight: 500; }
time { font-variant-numeric: tabular-nums; }
.empty-state { padding: 18px; border: 1px dashed #829fbb; border-radius: 5px; background: #ffffff80; font-size: 14px; }
.progress-panel { margin-top: 24px; }
.progress-panel > summary { color: var(--text); font-size: 17px; }
.progress-panel h2 { margin-top: 24px; }
.progress-panel li { font-size: 13px; color: var(--muted); padding: 8px 0; overflow-wrap: anywhere; }
.progress-panel li p { margin: 8px 0; }
.progress-panel h3 a { text-decoration: none; }
.hero { position: relative; overflow: hidden; min-height: 350px; display: grid; grid-template-columns: 1.2fr 1fr; align-items: center; padding: clamp(24px, 5vw, 60px); }
.hero h2 { font-size: clamp(30px, 4vw, 52px); line-height: 1.15; max-width: 600px; margin: 18px 0; letter-spacing: -.045em; }
.hero h2 span { color: var(--orange); }
.hero p { max-width: 460px; font-size: 15px; }
.button { display: inline-flex; text-decoration: none; color: white; background: linear-gradient(180deg, #ffbd66 0%, #e77a1c 48%, #c75b0a 52%, #b64c08 100%); border: 1px solid #a54505; border-radius: 5px; padding: 11px 20px; font-size: 13px; font-weight: 600; margin-top: 12px; text-shadow: 0 1px #8e3d04; box-shadow: inset 1px 1px #ffe0ac, 0 1px 2px #526b83; }
.button:hover { color: white; background: linear-gradient(180deg, #ffd08c, #ed8c36 50%, #d96810 51%, #c75b0a); }
.orbital { width: 250px; height: 250px; margin: auto; border: 1px solid #8aa9c5; border-radius: 50%; display: grid; place-items: center; box-shadow: 0 8px 20px #244c7340, inset 0 0 50px #d8efff; position: relative; background: radial-gradient(circle, #f7fbff, #cce8fa); }
.orbital::before { content: ""; position: absolute; inset: 24px; border: 1px dashed #70a579; border-radius: 50%; }
.orbital::after { content: ""; position: absolute; width: 10px; height: 10px; background: var(--green); border-radius: 50%; top: 45px; right: 28px; box-shadow: 0 0 10px #287a3580; }
.orbital-core { font-size: 72px; font-weight: 200; color: var(--light-blue); width: 132px; height: 132px; display: grid; place-items: center; border: 1px solid #77a6c8; border-radius: 24px; background: linear-gradient(145deg, #fff, #d5eafa); box-shadow: inset 1px 1px white, 0 2px 5px #6689a855; }
.guide-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; margin-top: 24px; }
.guide-grid h3 { margin-top: 16px; font-size: 17px; }
.guide-grid p { font-size: 13px; margin-bottom: 0; }
.footer { max-width: 1320px; margin: 0 auto; padding: 24px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; display: flex; justify-content: space-between; gap: 20px; letter-spacing: .05em; }
@media (max-width: 900px) {
    .workspace { grid-template-columns: 1fr; }
    .context-column { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; }
    .orbital { width: 200px; height: 200px; }
}
@media (max-width: 600px) {
    .topbar { padding: 16px 20px; gap: 16px; }
    .topbar nav { gap: 14px; }
    .protocol, .page-heading > .eyebrow { display: none; }
    main { padding: 28px 16px 40px; }
    .panel { padding: 22px; border-radius: 16px; }
    .hero, .guide-grid, .context-column { grid-template-columns: 1fr; }
    .orbital { margin: 36px auto 12px; width: 180px; height: 180px; }
    .orbital-core { width: 100px; height: 100px; font-size: 54px; }
    .footer { flex-direction: column; gap: 4px; }
    .temperature-stat { align-items: start; flex-direction: column; gap: 4px; }
    .reading-count { text-align: left; }
}
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
@media print {
    :root { --text: #111; --muted: #333; --orange: #a84900; --green: #176b3a; --light-blue: #005a91; --line: #bbb; }
    body, .panel, figure { background: white; color: black; box-shadow: none; }
    .topbar, .footer, .skip-link, .orbital { display: none; }
    main { padding: 0; }
    .workspace { display: block; }
    .panel { margin-bottom: 20px; break-inside: avoid; }
}
`

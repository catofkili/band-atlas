const COLORS = { 'east-asia': '#ef9f5a', western: '#79aefc', other: '#a891d7', unknown: '#737b87' };
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

export function createNetworkMap({ canvas, onChoose }) {
  let graph, nodes, pos, scale = 1, ox = 0, oy = 0, drag, pointers = new Map();
  const ctx = canvas.getContext('2d');
  async function load() {
    if (graph) return;
    graph = await fetch('data/graph.json').then((r) => r.json());
    nodes = new Map(graph.nodes.map((n, i) => [n.id, { ...n, i }])); pos = new Map();
    for (const n of graph.nodes) { const h = hash(n.id), a = (h % 6283) / 1000, r = 110 + Math.sqrt(h % 900000) * 1.7; pos.set(n.id, { x: Math.cos(a) * r, y: Math.sin(a) * r }); }
  }
  function resize() { canvas.width = canvas.clientWidth * devicePixelRatio; canvas.height = canvas.clientHeight * devicePixelRatio; draw(); }
  function draw() { if (!graph) return; const w = canvas.width / devicePixelRatio, h = canvas.height / devicePixelRatio; ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0); ctx.clearRect(0,0,w,h); ctx.translate(w/2+ox,h/2+oy); ctx.scale(scale,scale); ctx.strokeStyle='rgba(125,140,160,.16)'; ctx.lineWidth=1/scale; ctx.beginPath(); for(const e of graph.edges){const a=pos.get(e.from),b=pos.get(e.to);if(a&&b){ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y)}}ctx.stroke(); for(const n of nodes.values()){const p=pos.get(n.id), r=Math.max(2,Math.min(7,2+Math.log2(n.degree+1)));ctx.fillStyle=COLORS[n.region]||COLORS.unknown;ctx.beginPath();ctx.arc(p.x,p.y,r/scale,0,Math.PI*2);ctx.fill()} }
  function center(id) { const p=pos.get(id); if(p){ox=-p.x*scale;oy=-p.y*scale;draw()} }
  function hit(x,y) { const w=canvas.clientWidth,h=canvas.clientHeight; let best,bd=18; for(const n of nodes.values()){const p=pos.get(n.id), dx=w/2+ox+p.x*scale-x,dy=h/2+oy+p.y*scale-y,d=Math.hypot(dx,dy);if(d<bd){best=n;bd=d}}return best }
  canvas.addEventListener('pointerdown',e=>{canvas.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});drag={x:e.clientX,y:e.clientY,moved:false};});
  canvas.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId))return; const old=pointers.get(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY}); if(pointers.size===2){const q=[...pointers.values()];const d=Math.hypot(q[0].x-q[1].x,q[0].y-q[1].y),od=Math.hypot(old.x-q[1].x,old.y-q[1].y);if(od)scale=Math.max(.12,Math.min(5,scale*d/od));draw();return} if(drag){ox+=e.clientX-drag.x;oy+=e.clientY-drag.y;drag.x=e.clientX;drag.y=e.clientY;drag.moved=true;draw()}});
  canvas.addEventListener('pointerup',e=>{pointers.delete(e.pointerId);if(drag&&!drag.moved){const n=hit(e.clientX,e.clientY);if(n)onChoose(n.id)}drag=null});
  canvas.addEventListener('wheel',e=>{e.preventDefault();scale=Math.max(.12,Math.min(5,scale*(e.deltaY>0?.86:1.16)));draw()},{passive:false});
  return { async open(id){await load(); resize(); center(id);}, resize };
}

// Decorative transparent car render with animated heat shimmer.
// Shimmer follows the received alert state, never an estimated temperature. The image is local.
const canvas = document.querySelector('.cabin-scene');
if (canvas) {
  const ctx = canvas.getContext('2d');
  if (ctx) startScene(canvas, ctx);
}

function startScene(canvas, ctx) {
  const card = canvas.closest('.cabin-panel');
  const control = card.querySelector('.motion-control');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const theme = getComputedStyle(document.documentElement);
  const color = name => theme.getPropertyValue(name).trim();
  const orange = color('--logo-orange');
  const coral = color('--logo-coral');
  const pink = color('--logo-pink');
  const image = new Image();
  image.src = '/dashboard/assets/transparent-sedan.png';
  image.addEventListener('load', () => sync());
  let width=0,height=0,phase=0,frame=0,last=0,visible=true,hovered=false;
  let mode = document.body.getAttribute('data-cabin-mode') || 'waiting';
  const moving = () => !['offline', 'waiting', 'emergency'].includes(mode) && visible && !document.hidden && !reduced.matches && !control.open && !hovered;
  function draw() {
    if (!width || !height) return;
    ctx.clearRect(0,0,width,height);
    if (image.complete && image.naturalWidth) {
      const scale = Math.min(width / image.naturalWidth, (height - 8) / image.naturalHeight);
      const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
      // The high-detail car is a rendered asset; only gentle float and shimmer move.
      const bob = Math.sin(phase / 2) * 1.5;
      ctx.drawImage(image, (width - w) / 2, (height - h) / 2 + 4 + bob, w, h);
    }
    // Quiet while monitoring; increasing emphasis follows the box's alert state.
    const strength = { caution: .3, warning: .75, emergency: .9 }[mode] || 0;
    const count = mode === 'caution' ? 2 : 3;
    for(let i=0;i<count && strength>0;i++) {
      const wave=(phase*.3+i*.32)%1;
      const x=width*(.68+i*.06),y=height*.33-wave*12;
      const gradient=ctx.createLinearGradient(0,y,0,y-42);
      gradient.addColorStop(0,orange);gradient.addColorStop(.5,coral);gradient.addColorStop(1,pink);
      ctx.globalAlpha=strength*(.3+Math.sin(wave*Math.PI)*.7);
      ctx.strokeStyle=gradient;ctx.lineWidth=1.4;ctx.lineCap='round';ctx.beginPath();
      ctx.moveTo(x,y);ctx.bezierCurveTo(x-12,y-18,x+12,y-30,x,y-38);ctx.stroke();
    }
    ctx.globalAlpha=1;
  }
  function tick(now) {
    frame=0;
    if(!moving()){last=0;return;}
    if(!last || now-last>=32){phase+=last?Math.min((now-last)/1000,.1):0;last=now;draw();}
    frame=requestAnimationFrame(tick);
  }
  function sync() {
    if(frame) cancelAnimationFrame(frame);
    frame=0;last=0;draw();
    if(moving()) frame=requestAnimationFrame(tick);
  }
  new ResizeObserver(([entry])=>{
    width=entry.contentRect.width;height=entry.contentRect.height;
    const dpr=Math.min(devicePixelRatio||1,2);
    canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);sync();
  }).observe(canvas);
  new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;sync();}).observe(canvas);
  // Only actual state transitions restart rendering, not each polling update.
  new MutationObserver(()=>{
    const next=document.body.getAttribute('data-cabin-mode') || 'waiting';
    if(next!==mode){mode=next;sync();}
  }).observe(document.body,{attributes:true,attributeFilter:['data-cabin-mode']});
  control.addEventListener('toggle',sync);
  reduced.addEventListener('change',sync);
  document.addEventListener('visibilitychange',sync);
  card.addEventListener('pointerenter',event=>{if(event.pointerType==='mouse'){hovered=true;sync();}});
  card.addEventListener('pointerleave',()=>{hovered=false;sync();});
  window.addEventListener('pagehide',()=>{if(frame)cancelAnimationFrame(frame);});
  window.addEventListener('pageshow',sync);
}

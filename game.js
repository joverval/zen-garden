// The Quiet Garden — browser beta 1.10 (upright ground sprites)
// Garden time follows the JSON configuration. Live bird visits use real seconds.
const SAVE_KEY = 'quiet-garden-progress-v1'; // Preserve earlier local garden saves.
const NS = 'http://www.w3.org/2000/svg';
const $ = id => document.getElementById(id);
const copy = value => JSON.parse(JSON.stringify(value));
const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
const pad = value => String(value).padStart(2,'0');
let cfg, state, fountain=null, bird=null, dragging=null, lastWall=Date.now(), lastAnimation=0, lastSave=0, lastUI=0, flashTimer=0;
let nextId=1, savingAvailable=true, accumulatedActiveMs=0, rippleLayer=null, lastWaterPaint=0, lastScenePaint=0;
let sandCanvas=null, sandContext=null, liveRakeCanvas=null, liveRakeContext=null, rakePaintQueued=false, lastLivePaint=0, rakeDepthDirty=false;
let rakeRaster=null, rakeLiveRaster=null, rakeOwners=null, rakeBaseAlpha=null;
let birdGraphic=null,birdImage=null,squirrelGraphic=null,squirrelImage=null,snailGraphic=null,snailImage=null,antGraphic=null;
let birdFrame=-1,squirrelFrame=-1,snailFrame=-1;
let squirrelAgent=null,snailAgent=null,antAgent=null,antCargoGraphic=null,tracksGraphic=null,tracksDirty=true,lastTracksPaint=0;
const objectKinds = ['leaves','branches','nuts'];
// Keep decoded images alive for the entire session. SVG <image> references
// reuse these exact URLs, and no event begins before the cache is warm.
const assetCache = new Map();
let assetCacheReady = false;
function assetManifest(){
 const files=(cfg.assets?.textures||[]).map(name=>`./assets/${name}`);
 for(const [type,count] of Object.entries(cfg.assets?.spriteVariants||{})){
  for(let frame=1;frame<=count;frame++)files.push(`./sprites/${type}_${pad(frame)}.png`);
 }
 return [...new Set(files)];
}
async function preloadAssets(){
 const paths=assetManifest();
 const loading=$('assetLoading');
 loading.hidden=false;
 const concurrency=Math.max(1,Math.min(8,cfg.assets?.maxConcurrentDecodes||6));
 let next=0,finished=0;const failures=[];
 const loadOne=async src=>{
  const image=new Image();image.decoding='sync';image.src=src;
  assetCache.set(src,image);
  // decode() resolves only after the image is ready for the first render.
  try{await image.decode();}
  catch(err){
   // A failed decode should fail fast instead of waiting for an image event
   // that may already have fired before the handler was registered.
   failures.push(src);
  }
  finished++;
  loading.textContent=`Preparing the garden artwork · ${finished} / ${paths.length}`;
 };
 const workers=Array.from({length:Math.min(concurrency,paths.length)},async()=>{
  while(next<paths.length){const src=paths[next++];await loadOne(src);}
 });
 await Promise.all(workers);
 if(failures.length)throw new Error('The browser could not load these images: '+failures.join(', '));
 assetCacheReady=true;loading.hidden=true;
}

const rand=(a,b)=>a+Math.random()*(b-a);
function markDepth(type){return (cfg?.interaction?.marks?.depth||{})[type]??({bird:.4,squirrel:.6,snail:.1,ant:.1}[type]??.4);}
function addTrack(type,x,y,angle){
 if(!Number.isFinite(x)||!Number.isFinite(y)||!validPosition(x,y))return;
 if(!['bird','squirrel','snail','ant'].includes(type))return;
 state.footprints.push({x:+x.toFixed(2),y:+y.toFixed(2),angle:+angle.toFixed(1),type,depth:markDepth(type)});
 if(state.footprints.length>180)state.footprints.splice(0,state.footprints.length-180);
 state.world.tracks=state.footprints.length;tracksDirty=true;
}
function removeTracksUnderRake(a,b,radius){
 const before=state.footprints.length;
 state.footprints=state.footprints.filter(m=>distanceToSegment(m.x,m.y,a.x,a.y,b.x,b.y)>radius);
 if(before!==state.footprints.length){state.world.tracks=state.footprints.length;tracksDirty=true;}
}
const count = (kind) => state.objects.filter(o=>o.kind===kind).length;
const validPosition=(x,y)=> x>88&&x<697&&y>102&&y<456&&!inPond(x,y);
function inPond(x,y) { return ((x-644)/78)**2 + ((y-379)/69)**2 < 1.02; }
function newPosition(){for(let i=0;i<100;i++){let x=rand(111,681),y=rand(122,434);if(validPosition(x,y))return{x,y};}return{x:330,y:250};}
function addObject(kind,pos){const p=pos||newPosition();state.objects.push({id:`g${nextId++}`,kind,x:p.x,y:p.y});}
// Wet sand is a continuous surface, not a set of collectible objects.
const LOW_SPOTS=[{x:199,y:189,rx:76,ry:34,capacity:.92},{x:445,y:344,rx:88,ry:37,capacity:1},{x:357,y:252,rx:64,ry:28,capacity:.73},{x:536,y:177,rx:53,ry:29,capacity:.65}];
function syncPuddleCount(){state.world.puddles=state.puddleZones.filter(p=>p.depth>.045).length;}
function wetSand(amount){
 state.weather.sandWetness=clamp((state.weather.sandWetness||0)+amount,0,1);
 for(const p of state.puddleZones)p.depth=clamp(p.depth+amount*.94*(.6+.4*p.capacity),0,1);
 syncPuddleCount();
}
function weatherSurfaceStep(minutes,raining,sunny){
 const w=cfg.interaction.sandWater;
 const wetRate=raining?w.wetnessGainPerRainMinute:-(sunny?w.dryRatePerSunnyGardenMinute:w.dryRatePerCloudyGardenMinute);
 state.weather.sandWetness=clamp((state.weather.sandWetness||0)+minutes*wetRate,0,1);
 const poolRate=raining?w.puddleGainPerRainMinute:-(sunny?w.puddleDryRateSunny:w.puddleDryRateCloudy);
 for(const pool of state.puddleZones)pool.depth=clamp(pool.depth+minutes*(raining?poolRate*(.6+.4*pool.capacity):poolRate*(1.2-.25*pool.capacity)),0,1);
 const hadPuddles=state.world.puddles>0;
 syncPuddleCount();
 if(hadPuddles&&!state.world.puddles){state.naturalResolutions++;
   if(!document.hidden && !state.offlineStep)note('Sunlight dried the low spots. The blue-gray puddles disappeared.',{discoveryId:'sun_and_water'});
 }
}
function removeOrganic(id,kind,message,discoveryId){
 const idx=state.objects.findIndex(o=>o.id===id&&o.kind===kind);
 if(idx<0)return false;
 state.objects.splice(idx,1);
 state.world[kind]=Math.max(0,state.world[kind]-1);
 state.naturalResolutions++;
 if(!state.offlineStep)note(message,discoveryId?{discoveryId}:{});
 return true;
}
function nearestBorder(x,y){
 const candidates=[{x:83,y:clamp(y,105,451)},{x:708,y:clamp(y,105,451)},
  {x:clamp(x,91,699),y:99},{x:clamp(x,91,699),y:457}];
 return candidates.sort((a,b)=>Math.hypot(a.x-x,a.y-y)-Math.hypot(b.x-x,b.y-y))[0];
}
function nearSnailBorder(x,y){return x<166||x>622||y<161||y>399;}
function reconcileObjects(){
  for(const kind of objectKinds){
    let needed=Math.max(0,Math.round(state.world[kind]||0));
    let existing=state.objects.filter(o=>o.kind===kind);
    while(existing.length>needed){let victim=existing.splice(Math.floor(Math.random()*existing.length),1)[0];state.objects=state.objects.filter(o=>o.id!==victim.id);}
    while(existing.length<needed){addObject(kind);existing=state.objects.filter(o=>o.kind===kind);}
  }
  // Remove legacy puddle sprites. Convert their count to wet surface state once.
  state.objects=state.objects.filter(o=>o.kind!=='puddles');
  syncPuddleCount();
  state.world.tracks=state.footprints.length;
}

// Language follows the browser unless a player explicitly selects one.
const LANGUAGE_KEY='quiet-garden-language-v1';
const UI_TRANSLATIONS={
 "The Quiet Garden": "El Jardín Sereno",
 "The garden welcomes a new caretaker.": "El jardín recibe a una nueva persona que lo cuida.",
 "A Japanese courtyard · a practice in tending and trusting nature": "Un patio japonés · una práctica de cuidado y respeto por la naturaleza",
 "Language": "Idioma",
 "Beta 1.10": "Beta 1.10",
 "Garden volume": "Volumen del jardín",
 "Focus garden": "Solo jardín",
 "Exit focus": "Salir de vista jardín",
 "GARDEN DAY 1": "DÍA 1 DEL JARDÍN",
 "06:00 · Morning": "06:00 · Mañana",
 "TIME": "TIEMPO",
 "Clear sky": "Cielo despejado",
 "Wind": "Viento",
 "Rain · Wet sand": "Lluvia · Arena mojada",
 "Drying sand": "Arena secándose",
 "Quiet night": "Noche tranquila",
 "1 garden day = 20 real minutes · Offline time stays unchanged": "1 día del jardín = 20 minutos reales · El tiempo sin conexión no cambia",
 "Drag": "Arrastra",
 "Click": "Haz clic",
 "from the courtyard into the sand. Draw smooth waves and circles. Each rake pass replaces the grooves beneath it.": "desde el patio hasta la arena. Dibuja ondas y círculos. Cada pasada reemplaza los surcos anteriores.",
 "a leaf, branch, nut, or puddle to remove it. Raking also scares birds away. Birds, squirrels, snails, and ants leave marks that wind and rain can erase. The garden changes whether you act or observe.": "en una hoja, rama, nuez o charco para retirarlo. El rastrillo también espanta a las aves. Las aves, ardillas, caracoles y hormigas dejan huellas que el viento y la lluvia pueden borrar. El jardín cambia tanto si actúas como si observas.",
 "Today, in the garden": "Hoy en el jardín",
 "Read the changes": "Observa los cambios",
 "Read the events. Select a line when you notice a natural relationship.": "Lee los sucesos. Selecciona una línea cuando reconozcas una relación natural.",
 "Your practice": "Tu práctica",
 "Every action uses energy": "Cada acción consume energía",
 "Energy": "Energía",
 "Morning care · Once per garden day": "Cuidado matutino · Una vez al día del jardín",
 "Improvements": "Mejoras",
 "Nature journal": "Diario de la naturaleza",
 "Watch the garden. To learn from a natural interaction, select its entry in the event log.": "Observa el jardín. Para aprender de una interacción natural, selecciona su entrada en el registro.",
 "Leave the garden in peace": "Dejar el jardín en paz",
 "Your garden stays in this browser.": "Tu jardín permanece en este navegador.",
 "Export progress": "Exportar progreso",
 "Import progress": "Importar progreso",
 "Start a new garden": "Comenzar un jardín nuevo",
 "The garden will continue without you.": "El jardín continuará sin ti.",
 "You have done enough for today.": "Has hecho suficiente por hoy.",
 "Return whenever you wish": "Regresa cuando quieras",
 "♪ Start garden sounds": "♪ Activar sonidos del jardín",
 "♫ Ambient sound on": "♫ Sonido ambiental activo",
 "Preparing the garden artwork…": "Preparando las imágenes del jardín…",
 "Focus on the garden": "Mostrar solo el jardín",
 "Exit garden focus": "Salir de la vista del jardín",
 "The sun and moon move across the sky": "El sol y la luna cruzan el cielo",
 "A top-down Japanese courtyard. Drag the sand to rake, click objects to collect. Tree shadows move with the sun.": "Un patio japonés visto desde arriba. Arrastra para rastrillar y haz clic para recoger objetos. Las sombras de los árboles siguen al sol.",
 "Order": "Orden",
 "Harmony": "Armonía",
 "Natural resolutions": "Soluciones naturales",
 "Your actions": "Tus acciones",
 "Hand rake": "Rastrillo manual",
 "Drag from anywhere in the courtyard. Smooth curves and circles appear only on sand. Energy follows the distance over sand. Raking scares visiting birds away.": "Arrastra desde cualquier zona del patio. Las curvas y los círculos aparecen solo en la arena. La energía depende de la distancia recorrida sobre la arena. El rastrillo espanta a las aves.",
 "Daily care complete": "Cuidado diario completo",
 "Morning care · Restore energy": "Cuidado matutino · Recuperar energía",
 "Wider rake": "Rastrillo más ancho",
 "Widen the hand-rake stroke and clear a larger area of bird tracks.": "Amplía el ancho del rastrillo y elimina las huellas de las aves en un área mayor.",
 "Steady hands": "Manos firmes",
 "Reduce the energy cost per rake distance and object pickup by 8% per level.": "Reduce un 8 % por nivel el costo de energía del rastrillo y de la recogida de objetos.",
 "Gentle drainage": "Drenaje suave",
 "Help puddles disappear naturally.": "Ayuda a que los charcos desaparezcan de forma natural.",
 "Bird-friendly trees": "Árboles para aves",
 "Support more bird visits.": "Favorece las visitas de las aves.",
 "Max": "Máximo",
 "insight": "comprensión",
 "experience": "experiencia",
 "discoveries": "descubrimientos",
 "Observed": "Observado",
 "Read this event": "Leer este suceso",
 "A relationship remains unknown": "Una relación todavía es desconocida",
 "morning": "mañana",
 "day": "día",
 "evening": "tarde",
 "night": "noche",
 "Morning": "Mañana",
 "Day": "Día",
 "Evening": "Tarde",
 "Night": "Noche",
 "Wind and leaves": "El viento y las hojas",
 "Wind can remove dry leaves without your help.": "El viento puede retirar las hojas secas sin tu ayuda.",
 "Birds and branches": "Las aves y las ramas",
 "Birds can use branches that fall into the garden.": "Las aves pueden aprovechar las ramas que caen en el jardín.",
 "Rain and tracks": "La lluvia y las huellas",
 "Rain can soften tracks without any manual work.": "La lluvia puede borrar las huellas sin intervención manual.",
 "Sun and water": "El sol y el agua",
 "Puddles can disappear naturally during dry daylight.": "Los charcos pueden desaparecer de forma natural durante los días secos.",
 "Squirrels and nuts": "Las ardillas y las nueces",
 "Squirrels collect fallen nuts.": "Las ardillas recogen las nueces que caen.",
 "Seeds in the soil": "Semillas en la tierra",
 "Squirrels sometimes bury nuts instead of carrying them away.": "A veces, las ardillas entierran las nueces en lugar de retirarlas.",
 "New growth": "Nuevos brotes",
 "A forgotten seed can become a new plant.": "Una semilla olvidada puede convertirse en una planta.",
 "Ants and fallen materials": "Las hormigas y los restos naturales",
 "A small ant group can carry leaves, nuts, and branches from the sand.": "Un grupo de hormigas puede retirar hojas, nueces y ramas de la arena.",
 "Snails and leaves": "Los caracoles y las hojas",
 "Snails eat leaves that lie near their slow paths along the garden border.": "Los caracoles comen las hojas que encuentran junto al borde del jardín.",
 "A leaf falls onto the sand.": "Una hoja cae sobre la arena.",
 "A small branch falls near the stones.": "Una rama pequeña cae cerca de las piedras.",
 "A nut falls from a tree.": "Una nuez cae de un árbol.",
 "A gentle wind moves through the garden.": "Una brisa suave recorre el jardín.",
 "Rain falls across the courtyard, darkening sand and filling low spots.": "La lluvia cae sobre el patio, oscurece la arena y llena las zonas bajas.",
 "A bird lands in the sand and explores the courtyard.": "Un ave aterriza en la arena y explora el patio.",
 "A squirrel searches for nuts.": "Una ardilla busca nueces.",
 "A snail explores the moist border.": "Un caracol explora el borde húmedo.",
 "Ants arrive to collect fallen material near the sand.": "Llegan hormigas para recoger restos naturales cerca de la arena.",
 "Fireflies shimmer beside the pond.": "Las luciérnagas brillan junto al estanque.",
 "A dragonfly visits the pond.": "Una libélula visita el estanque.",
 "The wind changes the sand pattern.": "El viento modifica el patrón de la arena.",
 "A bird carries a branch toward its nest.": "Un ave lleva una rama hacia su nido.",
 "A squirrel carries a nut away.": "Una ardilla se lleva una nuez.",
 "A squirrel buries a nut in the soil.": "Una ardilla entierra una nuez.",
 "A buried nut develops into a small seedling.": "Una nuez enterrada comienza a germinar.",
 "Sunlight dried the low spots. The blue-gray puddles disappeared.": "La luz solar secó las zonas bajas. Los charcos azul grisáceos desaparecieron.",
 "Rain softened the animal tracks in the sand.": "La lluvia suavizó las huellas de los animales en la arena.",
 "A bird collected a branch and left a trail of footprints.": "Un ave recogió una rama y dejó un rastro de huellas.",
 "A squirrel collected a nut and left footprints.": "Una ardilla recogió una nuez y dejó huellas.",
 "A snail ate a fallen leaf beside the sand border.": "Un caracol comió una hoja caída junto al borde de la arena.",
 "A snail ate a leaf while you were away.": "Un caracol comió una hoja durante tu ausencia.",
 "Ants removed fallen material while you were away.": "Las hormigas retiraron restos naturales durante tu ausencia.",
 "The bird flew away when you raked the sand.": "El ave voló cuando rastrillaste la arena.",
 "The bird takes flight.": "El ave levanta el vuelo.",
 "You completed the daily ritual. Nothing else is required.": "Completaste el ritual diario. No necesitas hacer nada más.",
 "The daily ritual is complete.": "El ritual diario está completo.",
 "Not enough energy. Rest or observe.": "No tienes energía suficiente. Descansa u observa.",
 "Your energy is low. Observe the garden.": "Tienes poca energía. Observa el jardín.",
 "Rest a little. The garden can wait.": "Descansa un poco. El jardín puede esperar.",
 "The rake stops. Your energy is empty.": "El rastrillo se detiene. No tienes más energía.",
 "Saved locally in this browser.": "Progreso guardado en este navegador.",
 "Storage unavailable. Export progress to save a copy.": "El almacenamiento no está disponible. Exporta el progreso para conservar una copia.",
 "Choose a progress file smaller than 2 MB.": "Selecciona un archivo de progreso de menos de 2 MB.",
 "Replace the current garden with this save?": "¿Quieres reemplazar el jardín actual con este progreso?",
 "Start a new garden? This removes the saved local progress.": "¿Quieres comenzar un jardín nuevo? Esto elimina el progreso local.",
 "Cannot load garden.json. Start a local HTTP server and open http://localhost:8000.": "No se pudo cargar garden.json. Inicia un servidor HTTP local y abre http://localhost:8000.",
 "Could not prepare the garden artwork.": "No fue posible preparar las imágenes del jardín.",
 "The browser does not support Web Audio.": "El navegador no permite usar Web Audio."
};
let currentLanguage=(()=>{try{const saved=localStorage.getItem(LANGUAGE_KEY);if(saved==='en'||saved==='es')return saved;}catch(e){}
 return (navigator.language||'en').toLowerCase().startsWith('es')?'es':'en';})();
const originalStaticTexts=new WeakMap();
function translateText(source){
 if(currentLanguage!=='es'||source==null)return String(source??'');
 const raw=String(source), direct=UI_TRANSLATIONS[raw];if(direct)return direct;
 let m;
 if((m=/^A gentle wind moves through the garden\. It carries away (\d+) (leaf|leaves)\.$/.exec(raw)))return `Una brisa suave recorre el jardín y retira ${m[1]} ${m[1]==='1'?'hoja':'hojas'}.`;
 if((m=/^Ants carried a (leaf|branch|nut) out of the sand\.$/.exec(raw)))return `Las hormigas retiraron ${m[1]==='leaf'?'una hoja':m[1]==='branch'?'una rama':'una nuez'} de la arena.`;
 if((m=/^You raked (\d+) units of sand\.$/.exec(raw)))return `Rastrillaste ${m[1]} unidades de arena.`;
 if((m=/^You collected one (leaf|branche|nut)\. Energy −(\d+)\.$/.exec(raw)))return `Recogiste ${m[1]==='leaf'?'una hoja':m[1]==='nut'?'una nuez':'una rama'}. Energía −${m[2]}.`;
 if((m=/^−(\d+) energy · Collected (leaf|branche|nut)$/.exec(raw)))return `−${m[1]} de energía · Recogiste ${m[2]==='leaf'?'una hoja':m[2]==='nut'?'una nuez':'una rama'}`;
 if((m=/^While you were away, nature changed (\d+) things and resolved (\d+) disturbances\.$/.exec(raw)))return `Durante tu ausencia, la naturaleza cambió ${m[1]} cosas y resolvió ${m[2]} alteraciones.`;
 if((m=/^You improved (.+)\.$/.exec(raw)))return `Mejoraste ${translateText(m[1].replace(/^./,v=>v.toUpperCase()))}.`;
 if((m=/^Insight gained: (.+)$/.exec(raw)))return `Comprensión obtenida: ${translateText(m[1])}`;
 if((m=/^You noticed a relationship: ([^.]+)\. (.+)$/.exec(raw)))return `Reconociste una relación: ${translateText(m[1])}. ${translateText(m[2])}`;
 if((m=/^(.+) · level (\d+)$/.exec(raw)))return `${translateText(m[1])} · nivel ${m[2]}`;
 return raw;
}
function staticLanguage(){
 document.documentElement.lang=currentLanguage;
 $('languageSelect').value=currentLanguage;
 document.querySelectorAll('body *').forEach(element=>{
  if(['SCRIPT','STYLE','OPTION'].includes(element.tagName))return;
  if(element.closest('#metrics,#journal,#abilities,#upgrades,#discoveries,#sceneOverlay,#gardenSvg,#skySvg'))return;
  for(const node of element.childNodes){if(node.nodeType!==Node.TEXT_NODE||!node.nodeValue.trim())continue;
   if(!originalStaticTexts.has(node))originalStaticTexts.set(node,node.nodeValue);
   const original=originalStaticTexts.get(node),core=original.trim();
   node.nodeValue=original.replace(core,translateText(core));
  }
  for(const attr of ['aria-label','title']){
   if(!element.hasAttribute(attr))continue;
   const original='data-i18n-'+attr;
   if(!element.hasAttribute(original))element.setAttribute(original,element.getAttribute(attr));
   element.setAttribute(attr,translateText(element.getAttribute(original)));
  }
 });
}
function setLanguage(language){
 if(language!=='en'&&language!=='es')return;
 currentLanguage=language;
 try{localStorage.setItem(LANGUAGE_KEY,language);}catch(e){}
 staticLanguage();renderSound();renderUI();
}

function initialState(){
  const s={saveVersion:6,nextJournalId:2,gardenMinutes:0,world:copy(cfg.initialState.world),weather:copy(cfg.initialState.weather),activity:copy(cfg.initialState.activity),
    energy:cfg.initialState.energy,experience:0,insight:0,naturalResolutions:0,manualActions:0,birdScaredUntilGardenMinute:0,
    upgrades:Object.fromEntries(cfg.upgrades.map(u=>[u.id,0])),discoveries:[],cooldowns:{},dailyRitualDay:0,
    journal:[{id:1,day:1,time:'06:00',message:'The garden welcomes a new caretaker.'}],completed:false,
    preferences:{fountainEnabled:false,volume:cfg.audio.pondFountain.initialVolume,timeSpeed:cfg.time.defaultPlaybackSpeed||1},objects:[],footprints:[],rakeStrokes:[],puddleZones:LOW_SPOTS.map((p,i)=>({...p,depth:0,id:i}))};
  return s;
}
function migrate(s){
  if(!s || !s.world || !s.weather || !s.activity)return null;
  // Preserve progress from older prototypes; upgrade earlier journal entries in place.
  s.saveVersion=6;s.objects=Array.isArray(s.objects)?s.objects:[];
  if(!Number.isFinite(s.weather.sandWetness))s.weather.sandWetness=s.world.puddles>0?.65:0;
  s.weather.sandWetness=clamp(s.weather.sandWetness,0,1);
  if(!Array.isArray(s.puddleZones))s.puddleZones=LOW_SPOTS.map((p,i)=>({...p,depth:s.world.puddles>i?.55:0,id:i}));
  s.puddleZones=s.puddleZones.slice(0,4).map((p,i)=>({...LOW_SPOTS[i],depth:clamp(Number(p.depth)||0,0,1),id:i}));
  while(s.puddleZones.length<LOW_SPOTS.length){let i=s.puddleZones.length;s.puddleZones.push({...LOW_SPOTS[i],depth:0,id:i});}
  s.objects=s.objects.filter(o=>o.kind!=='puddles');
  s.birdScaredUntilGardenMinute=Number.isFinite(s.birdScaredUntilGardenMinute)?s.birdScaredUntilGardenMinute:0;
  s.journal=Array.isArray(s.journal)?s.journal:[];
  let journalId=1;
  for(const entry of [...s.journal].reverse()){
    if(!Number.isSafeInteger(entry.id)||entry.id<=0)entry.id=journalId;
    journalId=Math.max(journalId,entry.id+1);
  }
  s.nextJournalId=Math.max(journalId,Number.isSafeInteger(s.nextJournalId)?s.nextJournalId:1);
  s.upgrades=s.upgrades||{};
  for(const upgrade of cfg.upgrades){
    if(!Number.isInteger(s.upgrades[upgrade.id]))s.upgrades[upgrade.id]=upgrade.id==='wideRake'?(s.upgrades.quickRake||0):0;
  }
  
  s.footprints=Array.isArray(s.footprints)?s.footprints:[];
  // Convert old bird trails to typed marks. Preserve existing footprints.
  for(const mark of s.footprints){
    mark.type=['bird','squirrel','snail','ant'].includes(mark.type)?mark.type:'bird';
    const standard=markDepth(mark.type);
    mark.depth=Number.isFinite(mark.depth)?clamp(mark.depth,0,1):standard;
  }
  s.footprints=s.footprints.filter(m=>Number.isFinite(m.x)&&Number.isFinite(m.y)&&m.depth>0).slice(-180);
  if(s.footprints.length===0 && s.world.tracks>0){
   // Restore genuine earlier track counts once; new weather never creates tracks.
   for(let i=0;i<Math.min(30,s.world.tracks);i++){
    const p=newPosition();s.footprints.push({x:p.x,y:p.y,angle:rand(0,360),type:'bird',depth:markDepth('bird')});
   }
  }

  // Old saves stored random sprite rotations. They no longer affect artwork.
  for(const ob of s.objects)delete ob.rotation;
  s.rakeStrokes=Array.isArray(s.rakeStrokes)?s.rakeStrokes:[];
  // Group old independent segments into continuous paths, without deleting the
  // player's previous raking. Old beta releases saved every pointer movement.
  if(s.rakeStrokes.some(mark=>Number.isFinite(mark.x1))){
    const combined=[];
    for(const mark of s.rakeStrokes){
      if(!Number.isFinite(mark.x1)){combined.push(mark);continue;}
      const previous=combined.at(-1),end=previous?.points?.at(-1);
      const contiguous=end&&Math.hypot(end[0]-mark.x1,end[1]-mark.y1)<1.5&&previous.points.length<2900;
      if(contiguous)previous.points.push([mark.x2,mark.y2]);
      else combined.push({points:[[mark.x1,mark.y1],[mark.x2,mark.y2]]});
    }
    s.rakeStrokes=combined;
  }
  // Recompress earlier beta strokes once. Keep the same save key and garden state.
  const maxStored=cfg.interaction.rake.maxStoredStrokes||180;
  s.rakeStrokes=s.rakeStrokes.slice(-maxStored);
  for(const mark of s.rakeStrokes){
   if(mark.points?.length>2){
    if(mark.points.length>10&&!mark.closed){
     const a=mark.points[0],b=mark.points.at(-1);
     mark.closed=Math.hypot(a[0]-b[0],a[1]-b[1])<6;
    }
    mark.points=compactRakePoints(mark.points,!!mark.closed);
   }
   // Existing saves did not include depth. Their marks began at full depth.
   mark.depth=Number.isFinite(mark.depth)?clamp(mark.depth,0,1):1;
  }
  s.rakeStrokes=s.rakeStrokes.filter(mark=>mark.points?.length>=2 && (mark.depth>0 || cfg.interaction.rake.overlapMode==='replace'));
  s.preferences=s.preferences||{fountainEnabled:false,volume:.25};
  if(!cfg.time.playbackSpeeds.includes(s.preferences.timeSpeed))s.preferences.timeSpeed=cfg.time.defaultPlaybackSpeed;
  for(const kind of objectKinds) if(!Number.isFinite(s.world[kind]))s.world[kind]=0;
  if(!Number.isFinite(s.world.tracks))s.world.tracks=0;
  nextId=Math.max(1,...s.objects.map(o=>Number(String(o.id).slice(1))||0))+1;
  if(!Number.isFinite(s.energy)||!Number.isFinite(s.gardenMinutes)||!s.upgrades)return null;
  state=s;
  reconcileObjects();
  return s;
}
function validSave(s){
  if(!s||!s.world||!s.weather||!Number.isFinite(s.gardenMinutes)||s.gardenMinutes<0||s.gardenMinutes>1e9)return false;
  if(!Number.isFinite(s.energy)||s.energy<0||s.energy>100)return false;
  if(!s.activity||!s.upgrades||!Array.isArray(s.discoveries)||!Array.isArray(s.journal))return false;
  if(s.objects && (!Array.isArray(s.objects)||s.objects.length>200))return false;
  if(s.footprints && (!Array.isArray(s.footprints)||s.footprints.length>200))return false;
  if(s.footprints?.some(m=>m.depth!==undefined&&(!Number.isFinite(m.depth)||m.depth<0||m.depth>1)))return false;
  if(s.puddleZones&&(!Array.isArray(s.puddleZones)||s.puddleZones.length>10||s.puddleZones.some(p=>!Number.isFinite(p.depth))))return false;
  if(s.rakeStrokes && (!Array.isArray(s.rakeStrokes)||s.rakeStrokes.length>1600))return false;
  // Store curves rather than one isolated segment for each pointer event.
  if(s.rakeStrokes?.some(mark=>mark.points && (!Array.isArray(mark.points)||mark.points.length>3000)))return false;
  if(s.rakeStrokes?.some(mark=>mark.depth!==undefined && (!Number.isFinite(mark.depth)||mark.depth<0||mark.depth>1)))return false;
  for(const key of ['leaves','branches','nuts','puddles','tracks']) if(!Number.isFinite(s.world[key])||s.world[key]<0||s.world[key]>1000)return false;
  return true;
}
function loadSave(){try{const raw=localStorage.getItem(SAVE_KEY);if(!raw)return null;const record=JSON.parse(raw);return validSave(record.state)&&Number.isFinite(record.savedAt)?record:null;}catch(e){savingAvailable=false;return null;}}
function save(){try{localStorage.setItem(SAVE_KEY,JSON.stringify({schemaVersion:cfg.schemaVersion,savedAt:Date.now(),state}));savingAvailable=true;lastSave=Date.now();$('saveStatus').textContent=translateText('Saved locally in this browser.');}catch(e){savingAvailable=false;$('saveStatus').textContent=translateText('Storage unavailable. Export progress to save a copy.');}}
function hour(){return ((state.gardenMinutes+cfg.time.initialClockHour*60)%1440)/60;}
function day(){return 1+Math.floor((state.gardenMinutes+cfg.time.initialClockHour*60)/1440);}
function timeLabel(){let t=Math.floor((state.gardenMinutes+cfg.time.initialClockHour*60)%1440);return `${pad(Math.floor(t/60))}:${pad(t%60)}`;}
function phase(){let h=hour();return h>=5&&h<10?'morning':h>=10&&h<17?'day':h>=17&&h<20?'evening':'night';}
function valueAt(path){if(path==='phase')return phase();if(path==='world.organicDebris')return state.world.leaves+state.world.branches+state.world.nuts;return path.split('.').reduce((v,key)=>v?.[key],state);}
function setAt(path,val){const parts=path.split('.');let target=state;for(let i=0;i<parts.length-1;i++)target=target[parts[i]];
 const limits=cfg.limits[path];target[parts.at(-1)]=limits?clamp(val,...limits):val;}
function matches(conditions=[]){return conditions.every(c=>{let v=valueAt(c.path);switch(c.op){case'eq':return v===c.value;case'neq':return v!==c.value;case'gt':return v>c.value;case'gte':return v>=c.value;case'lt':return v<c.value;case'lte':return v<=c.value;default:return false;}});}
// Erode each visible mark once at weather onset. Values never become negative.
// All rake grooves and wildlife traces use the same 0..1 depth scale.
function erodeMarks(amount){
 if(!Number.isFinite(amount)||amount<=0)return 0;
 let changed=0;
 for(const collection of [state.rakeStrokes,state.footprints]){
  for(const mark of collection){
   const old=Number.isFinite(mark.depth)?clamp(mark.depth,0,1):(collection===state.rakeStrokes?1:markDepth(mark.type||'bird'));
   const depth=clamp(Math.round((old-amount)*10000)/10000,0,1);
   if(depth!==old){mark.depth=depth;changed++;}
  }
 }
 if(changed){
  // Keep invisible replacement paths as erasure masks. Old grooves must not return.
  if(cfg.interaction.rake.overlapMode!=='replace')state.rakeStrokes=state.rakeStrokes.filter(m=>m.depth>0);
  state.footprints=state.footprints.filter(m=>m.depth>0);
  state.world.tracks=state.footprints.length;
  tracksDirty=true;rakeDepthDirty=true;
 }
 return changed;
}

// Wind moves actual individual leaf objects, not only the displayed count.
// The weather event removes half the existing leaves once per wind onset.
function removeWindLeaves(){
 const settings=cfg.interaction.windLeafRemoval;
 const leaves=state.objects.filter(o=>o.kind==='leaves');
 const n=leaves.length;
 if(!n)return 0;
 const amount=n<=settings.clearWhenAtMost?n:Math.min(n,Math.ceil(n*settings.fraction));
 for(let i=leaves.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[leaves[i],leaves[j]]=[leaves[j],leaves[i]];}
 const removedIds=new Set(leaves.slice(0,amount).map(o=>o.id));
 state.objects=state.objects.filter(o=>!removedIds.has(o.id));
 state.world.leaves=state.objects.filter(o=>o.kind==='leaves').length;
 state.naturalResolutions+=amount;
 return amount;
}
function effects(list){
 const summary={removedLeaves:0};
 for(const e of list){
  if(e.type==='set')setAt(e.path,e.value);
  else if(e.type==='add')setAt(e.path,(valueAt(e.path)||0)+e.amount);
  else if(e.type==='erodeMarks'||e.type==='erodeRakeDepth')erodeMarks(e.amount);
  else if(e.type==='wetSand')wetSand(e.amount);
  else if(e.type==='removeWindLeaves')summary.removedLeaves+=removeWindLeaves();
 }
 reconcileObjects();
 return summary;
}
function note(message,options={}){
  // A recorded event offers an insight, but observation requires a deliberate click.
  const entry={id:state.nextJournalId++,day:day(),time:timeLabel(),message};
  if(options.discoveryId)entry.discoveryId=options.discoveryId;
  state.journal.unshift(entry);
  state.journal=state.journal.slice(0,cfg.insightDiscovery.maxJournalEntries);
  return entry;
}
function flash(message){let el=$('sceneOverlay');el.textContent=translateText(message);el.classList.add('visible');clearTimeout(flashTimer);flashTimer=setTimeout(()=>el.classList.remove('visible'),2500);}
function noticeInteraction(journalId){
  const entry=state.journal.find(r=>r.id===journalId);
  if(!entry||!entry.discoveryId||state.discoveries.includes(entry.discoveryId))return;
  const d=cfg.discoveries.find(x=>x.id===entry.discoveryId);
  if(!d)return;
  // An offline result cannot be claimed: the player must witness its journal event in active play.
  state.discoveries.push(d.id);
  state.insight+=cfg.insightDiscovery.insightPerUniqueDiscovery;
  entry.observed=true;
  flash(`Insight gained: ${d.title}`);
  note(`You noticed a relationship: ${d.title}. ${d.description}`);
  save();renderUI();
}
function antsRateForDebris(total){
 const {curve,maxRatePerDay}=cfg.interaction.ants.visitsPerGardenDay;
 if(total<=curve[0][0])return curve[0][1];
 for(let i=1;i<curve.length;i++){
  if(total<=curve[i][0]){
   const [x0,y0]=curve[i-1],[x1,y1]=curve[i];
   return Math.min(maxRatePerDay,y0+(y1-y0)*(total-x0)/(x1-x0));
  }
 }
 return Math.min(maxRatePerDay,curve.at(-1)[1]);
}
function eventRate(rule){let rate=rule.id==='ants_appear'?antsRateForDebris(state.world.leaves+state.world.branches+state.world.nuts):rule.ratePerDay;if(rule.id==='bird_visits')rate*=1+(state.upgrades.birdHabitat||0)*.35;if(rule.rateBonusUpgrade)rate*=1+(state.upgrades[rule.rateBonusUpgrade]||0)*(rule.rateBonusPerLevel||0);return rate;}
function step(minutes,offline,counts){
 state.gardenMinutes+=minutes;
 const raining=state.weather.rainMinutes>0, sunny=hour()>=6&&hour()<=18;
 state.weather.moisture=clamp(state.weather.moisture+(raining?.11:sunny?-.031:-.009)*minutes,0,100);
 weatherSurfaceStep(minutes,raining,sunny);
 for(const key of ['rainMinutes','windMinutes'])state.weather[key]=Math.max(0,state.weather[key]-minutes);
 for(const key of Object.keys(state.activity))state.activity[key]=Math.max(0,state.activity[key]-minutes);
 state.energy=clamp(state.energy+minutes*.065,0,100);
 for(const rule of [...cfg.events,...cfg.interactions]){
   if(!matches(rule.conditions))continue;
   if(rule.id==='bird_visits'&&(phase()==='night'||dragging||state.gardenMinutes<state.birdScaredUntilGardenMinute))continue;
   if(rule.group==='largeWildlife'&&(state.activity.birdMinutes>0||state.activity.squirrelMinutes>0))continue;
   if(rule.group==='smallLife'&&['snailMinutes','antMinutes','dragonflyMinutes','fireflyMinutes'].filter(k=>state.activity[k]>0).length>=cfg.visualLimits.smallAnimals)continue;
   if(Math.random()>=1-Math.exp(-eventRate(rule)*minutes/1440))continue;
   if(!offline&&['bird_collects_branch','squirrel_collects_nut','squirrel_buries_nut'].includes(rule.id))continue; // Live animals must reach the target first.
   const hasVisibleTracks=state.footprints.some(m=>m.depth>0);
   const outcome=effects(rule.effects);counts[rule.id]=(counts[rule.id]||0)+1;
   if(rule.id==='bird_visits'&&!offline&&!bird)spawnBird();
   if(rule.id==='squirrel_visits'&&!offline&&!squirrelAgent)spawnSquirrel();
   if(rule.id==='snail_appears'&&!offline&&!snailAgent)spawnSnail();
   if(rule.id==='ants_appear'&&!offline&&!antAgent)spawnAnts();
   if(!offline&&(rule.discovery||rule.group!=='vegetation')){
     const meaningfulWind=rule.id==='wind_begins'&&outcome.removedLeaves>0;
     const text=meaningfulWind?`${rule.label} It carries away ${outcome.removedLeaves} ${outcome.removedLeaves===1?'leaf':'leaves'}.`:rule.label;
     const discoveryId=rule.id==='wind_begins'&&!meaningfulWind?null:rule.discovery;
     note(text,discoveryId?{discoveryId}:{});
     if(rule.id==='rain_begins'&&hasVisibleTracks)note('Rain softened the animal tracks in the sand.',{discoveryId:'rain_and_tracks'});
   }
   // Nature advances during offline time, but insight never arrives automatically.

 }
 if(offline&&state.activity.antMinutes>0&&Math.random()<1-Math.exp(-18*minutes/1440)){
   const choices=state.objects.filter(o=>cfg.interaction.ants.targetKinds.includes(o.kind));
   if(choices.length){const ob=choices[Math.floor(Math.random()*choices.length)];
     removeOrganic(ob.id,ob.kind,'Ants removed fallen material while you were away.');counts.ants_transport=(counts.ants_transport||0)+1;}
 }
 if(offline&&state.activity.snailMinutes>0&&Math.random()<1-Math.exp(-16*minutes/1440)){
   const leaves=state.objects.filter(o=>o.kind==='leaves'&&nearSnailBorder(o.x,o.y));
   if(leaves.length){const ob=leaves[Math.floor(Math.random()*leaves.length)];
     removeOrganic(ob.id,'leaves','A snail ate a leaf while you were away.');counts.snail_feeding=(counts.snail_feeding||0)+1;}
 }
}
function advance(minutes,offline=false){
 let counts={};if(minutes<=0)return counts;
 state.offlineStep=offline;
 for(let left=minutes;left>1e-4;){let dt=Math.min(left,offline?cfg.time.simulationStepGardenMinutes:1.5);step(dt,offline,counts);left-=dt;}
 state.offlineStep=false;
 if(rakeDepthDirty){refreshRakeDepth();rakeDepthDirty=false;if(dragging?.stroke)scheduleLiveRake();}
 if(tracksDirty)renderTracks();
 return counts;
}
function offlineAdvance(savedAt){let elapsed=Math.max(0,Date.now()-savedAt),minutes=Math.min(elapsed/60000*1440/(cfg.time.offlineRealHoursPerGardenDay*60),cfg.time.maxOfflineGardenDays*1440);
 if(minutes<1)return;const prev=state.naturalResolutions,results=advance(minutes,true),n=Object.values(results).reduce((a,b)=>a+b,0);
 note(`While you were away, nature changed ${n} things and resolved ${state.naturalResolutions-prev} disturbances.`);
 state.activity.birdMinutes=0; // A bird does not remain on screen after a long absence.
}
function order(){let w=state.world;return clamp(Math.round(100-w.leaves*5-w.branches*9-w.nuts*2-w.tracks*1.2-w.puddles*8-w.sandDisturbance*.7),0,100);}
function harmony(){let m=state.weather.moisture;return clamp(Math.round(67+(state.upgrades.birdHabitat||0)*6+(state.upgrades.drainage||0)*4+Math.min(state.naturalResolutions,22)*.7-Math.max(0,20-m)*.4-Math.max(0,m-85)*.4),0,100);}
function pickup(id){const ob=state.objects.find(o=>o.id===id);if(!ob)return;
 const cost=cfg.interaction.pickup[ob.kind]||4, discounted= Math.max(1,cost*(1-(state.upgrades.steadyHands||0)*.08));
 if(state.energy<discounted){flash('Not enough energy. Rest or observe.');return;}
 state.objects=state.objects.filter(o=>o.id!==id);state.world[ob.kind]=Math.max(0,state.world[ob.kind]-1);
 state.energy-=discounted;state.experience+=Math.max(1,Math.ceil(discounted*.4));state.manualActions++;
 note(`You collected one ${ob.kind.slice(0,-1)}. Energy −${Math.round(discounted)}.`);
 flash(`−${Math.round(discounted)} energy · Collected ${ob.kind.slice(0,-1)}`);save();renderUI();renderScene();
}
function startBird(){ // The visit duration uses actual wall-clock seconds.
 if(phase()==='night')return;
 const b=cfg.interaction.bird, p={x:rand(200,530),y:rand(170,330)};
 bird={x:p.x,y:p.y,target:null,remaining:rand(b.visitRealSecondsMin,b.visitRealSecondsMax),distanceSinceFootprint:0,collected:false,wait:0};
 state.activity.birdMinutes=bird.remaining*1440/(cfg.time.activeRealMinutesPerGardenDay*60);
 playAmbientCue('birds');
 if(fountain)fountain.nextBirdAt=Date.now()+rand(8500,14500);
}
function spawnBird(){if(!bird)startBird();}
function scareBird(){if(!bird)return;bird=null;stopAmbientCue('birds');state.activity.birdMinutes=0;state.birdScaredUntilGardenMinute=state.gardenMinutes+cfg.interaction.bird.returnDelayGardenMinutes;note('The bird flew away when you raked the sand.');flash('The bird takes flight.');}
function targetForBird(){
 let branches=state.objects.filter(o=>o.kind==='branches'&&o.id!==antAgent?.cargo?.id);
 if(!bird.collected&&branches.length)return branches.sort((a,b)=>Math.hypot(bird.x-a.x,bird.y-a.y)-Math.hypot(bird.x-b.x,bird.y-b.y))[0];
 let p=newPosition();return {x:p.x,y:p.y,id:null};
}
function birdUpdate(dt){if(!bird)return;if(phase()==='night'){bird=null;stopAmbientCue('birds');state.activity.birdMinutes=0;return;}bird.remaining-=dt;
 if(bird.remaining<=0){bird=null;stopAmbientCue('birds');state.activity.birdMinutes=0;return;}
 const b=cfg.interaction.bird;
 if(!bird.target||Math.hypot(bird.x-bird.target.x,bird.y-bird.target.y)<12){
   if(bird.target?.id && !bird.collected){
     bird.wait+=dt;
     if(bird.wait>=b.branchCollectionSeconds){
       const branch=state.objects.find(o=>o.id===bird.target.id&&o.id!==antAgent?.cargo?.id);
       if(branch){state.objects=state.objects.filter(o=>o.id!==branch.id);state.world.branches=Math.max(0,state.world.branches-1);state.naturalResolutions++;note('A bird collected a branch and left a trail of footprints.',{discoveryId:'birds_and_branches'});}
       bird.collected=true;bird.target=null;bird.wait=0;
     }
   } else {bird.target=targetForBird();bird.wait=0;}
   return;
 }
 bird.wait=0;
 let dx=bird.target.x-bird.x,dy=bird.target.y-bird.y,dist=Math.hypot(dx,dy),stepDist=Math.min(dist,b.movementSpeedPixelsPerSecond*dt);
 bird.x+=dx/dist*stepDist;bird.y+=dy/dist*stepDist;
 if(!validPosition(bird.x,bird.y)){bird.target=targetForBird();return;}
 bird.distanceSinceFootprint+=stepDist;
 if(bird.distanceSinceFootprint>=b.footprintEveryPixels){bird.distanceSinceFootprint=0;
   addTrack('bird',bird.x,bird.y,Math.atan2(dy,dx)*180/Math.PI+90);
 }
}
// Squirrels enter from outside the courtyard and move toward a real nut.
function spawnSquirrel(){
 const nuts=state.objects.filter(o=>o.kind==='nuts'&&o.id!==antAgent?.cargo?.id);
 if(!nuts.length)return;
 const target=nuts[Math.floor(Math.random()*nuts.length)];
 const edge=target.x<390?{x:73,y:clamp(target.y+rand(-35,35),116,444)}:{x:717,y:clamp(target.y+rand(-35,35),116,444)};
 squirrelAgent={x:edge.x,y:edge.y,targetId:target.id,phase:'enter',heading:0,step:0};
}
function spawnSnail(){
 // Every path follows a narrow ring near two courtyard borders.
 // The center (x 220..575, y 195..380) stays untouched.
 const routes=[
  [[75,170],[109,170],[109,119],[460,119],[460,90]],
  [[350,467],[350,427],[112,427],[112,286],[76,286]],
  [[610,89],[610,122],[685,122],[685,252],[717,252]],
  [[75,370],[112,370],[112,430],[310,430],[310,468]]
 ];
 const route=copy(routes[Math.floor(Math.random()*routes.length)]);
 snailAgent={x:route[0][0],y:route[0][1],points:route.slice(1),step:0,heading:0};
}
function nearestAntItem(x,y,radius=cfg.interaction.ants.searchRadius){
 const items=state.objects.filter(o=>cfg.interaction.ants.targetKinds.includes(o.kind) && o.id!==squirrelAgent?.targetId && o.id!==bird?.target?.id);
 const available=items.map(o=>({o,d:Math.hypot(o.x-x,o.y-y)})).filter(v=>v.d<=radius).sort((a,b)=>a.d-b.d);
 return available.length?available[0].o:null;
}
function spawnAnts(){
 const items=state.objects.filter(o=>cfg.interaction.ants.targetKinds.includes(o.kind));
 if(!items.length)return;
 const p=items[Math.floor(Math.random()*items.length)];
 const border=nearestBorder(p.x,p.y);
 antAgent={x:border.x,y:border.y,phase:'search',targetId:p.id,exit:null,cargo:null,heading:0,step:0};
}
function findNearbySnailLeaf(a){
 const range=cfg.interaction.snails.leafDetectionRadius;
 return state.objects.filter(o=>o.kind==='leaves'&&nearSnailBorder(o.x,o.y)&&o.id!==antAgent?.cargo?.id)
  .map(o=>({o,d:Math.hypot(a.x-o.x,a.y-o.y)}))
  .filter(v=>v.d<range).sort((x,y)=>x.d-y.d)[0]?.o||null;
}

function makeAntCargo(group,cargo){
 const g=svg('g',{transform:'translate(-1 -8)'},group);
 const src=cargo.kind==='leaves'?spritePath('leaf',cargo.id,5):cargo.kind==='branches'?spritePath('branch',cargo.id,5):spritePath('nut',cargo.id,3);
 const size=cargo.kind==='branches'?[30,20]:cargo.kind==='leaves'?[21,22]:[16,16];
 imageSprite(g,src,-size[0]/2,-size[1]/2,...size);
 return g;
}
function moveAgent(agent,target,speed,dt){
 const dx=target.x-agent.x,dy=target.y-agent.y,dist=Math.hypot(dx,dy);
 if(dist<.01)return {arrived:true,moved:0};
 const moved=Math.min(speed*dt,dist);
 agent.x+=dx/dist*moved;agent.y+=dy/dist*moved;
 agent.heading=Math.atan2(dy,dx)*180/Math.PI+90;
 return {arrived:moved>=dist-.01,moved};
}
function wildlifeUpdate(dt){
 if(squirrelAgent){
  if(state.activity.squirrelMinutes<=0){squirrelAgent=null;}
  else{
   const a=squirrelAgent;
   const nut=state.objects.find(o=>o.id===a.targetId&&o.id!==antAgent?.cargo?.id);
   if(a.phase==='enter'&&!nut)a.phase='exit';
   const target=a.phase==='enter'&&nut?nut:{x:a.x<390?73:717,y:clamp(a.y,105,450)};
   const result=moveAgent(a,target,36,dt);
   a.step+=result.moved;
   if(a.step>=14){a.step=0;addTrack('squirrel',a.x,a.y,a.heading);}
   if(result.arrived&&a.phase==='enter'&&nut){
    state.objects=state.objects.filter(o=>o.id!==nut.id);
    state.world.nuts=Math.max(0,state.world.nuts-1);
    state.naturalResolutions++;
    note('A squirrel collected a nut and left footprints.',{discoveryId:'squirrels_and_nuts'});
    a.phase='exit';
   }else if(result.arrived&&a.phase==='exit'){
    squirrelAgent=null;state.activity.squirrelMinutes=0;
   }
  }
 }
 if(snailAgent){
  if(state.activity.snailMinutes<=0){snailAgent=null;}
  else{
   const a=snailAgent;
   let leaf=a.foodId&&state.objects.find(o=>o.id===a.foodId&&o.kind==='leaves'&&o.id!==antAgent?.cargo?.id);
   if(!leaf){leaf=findNearbySnailLeaf(a);a.foodId=leaf?.id||null;}
   const waypoint=a.points[0];
   if(!waypoint&&!leaf){snailAgent=null;state.activity.snailMinutes=0;}
   else{
    const dest=leaf?{x:leaf.x,y:leaf.y}:{x:waypoint[0],y:waypoint[1]};
    const result=moveAgent(a,dest,cfg.interaction.snails.movementPixelsPerSecond,dt);
    a.step+=result.moved;
    if(a.step>=cfg.interaction.snails.trackSpacingPixels){a.step=0;addTrack('snail',a.x,a.y,a.heading);}
    if(result.arrived&&leaf){
     removeOrganic(leaf.id,'leaves','A snail ate a fallen leaf beside the sand border.','snails_and_leaves');
     a.foodId=null;
    }else if(result.arrived&&!leaf){a.points.shift();if(!a.points.length){snailAgent=null;state.activity.snailMinutes=0;}}
   }
  }
 }
 if(antAgent){
  if(state.activity.antMinutes<=0){antAgent=null;}
  else{
   const a=antAgent;
   let item=a.phase==='search'?state.objects.find(o=>o.id===a.targetId):null;
   if(a.phase==='search'&&!item){item=nearestAntItem(a.x,a.y);a.targetId=item?.id;}
   if(!item&&a.phase==='search')a.phase='exit';
   if(a.phase==='exit'&&!a.exit)a.exit=nearestBorder(a.x,a.y);
   const destination=a.phase==='search'&&item?item:a.exit;
   if(destination){
    const result=moveAgent(a,destination,cfg.interaction.ants.movementPixelsPerSecond,dt);
    a.step+=result.moved;
    if(a.step>=cfg.interaction.ants.trackSpacingPixels){a.step=0;addTrack('ant',a.x,a.y,a.heading);}
    if(result.arrived&&a.phase==='search'&&item){
      a.phase='carry';a.cargo={id:item.id,kind:item.kind};a.exit=nearestBorder(a.x,a.y);
      // The carried sprite belongs to the ants, not the original sand position.
      document.querySelector(`[data-object-id="${item.id}"]`)?.remove();
      if(antCargoGraphic)antCargoGraphic.remove();
      if(antGraphic)antCargoGraphic=makeAntCargo(antGraphic,a.cargo);
    }else if(result.arrived&&a.phase!=='search'){
      if(a.cargo)removeOrganic(a.cargo.id,a.cargo.kind,`Ants carried a ${a.cargo.kind==='leaves'?'leaf':a.cargo.kind==='branches'?'branch':'nut'} out of the sand.`, 'ants_and_debris');
      antAgent=null;antCargoGraphic=null;state.activity.antMinutes=0;
      // Clear the carried sprite and refresh the affected objects on the next scene pass.
    }
   }
  }
 }

}
// Map the pointer through the SVG transform. This works at every responsive size.
function screenPoint(ev){
 const svgRoot=$('gardenSvg');
 const pt=svgRoot.createSVGPoint();pt.x=ev.clientX;pt.y=ev.clientY;
 const matrix=svgRoot.getScreenCTM();
 if(!matrix)return{x:0,y:0};
 const local=pt.matrixTransform(matrix.inverse());
 return{x:local.x,y:local.y};
}
// Two canvases keep completed marks stable while the current mark follows the pointer.
// Both canvases have the same SVG coordinate space. Neither receives pointer events.
function ensureSandCanvas(parent){
 const foreign=svg('foreignObject',{x:80,y:95,width:631,height:364,'pointer-events':'none'},parent);
 const holder=document.createElement('div');
 holder.style.cssText='position:relative;width:631px;height:364px;pointer-events:none;';
 if(!sandCanvas){
   sandCanvas=document.createElement('canvas');
   liveRakeCanvas=document.createElement('canvas');
   for(const canvas of [sandCanvas,liveRakeCanvas]){
     canvas.width=1262;canvas.height=728;
     canvas.style.cssText='position:absolute;inset:0;display:block;width:631px;height:364px;pointer-events:none;';
   }
   sandContext=sandCanvas.getContext('2d',{alpha:true});
   liveRakeContext=liveRakeCanvas.getContext('2d',{alpha:true});
   for(const ctx of [sandContext,liveRakeContext])ctx.setTransform(2,0,0,2,-160,-190);
   rakeRaster=new ImageData(sandCanvas.width,sandCanvas.height);
   rakeLiveRaster=new ImageData(sandCanvas.width,sandCanvas.height);
   rakeOwners=new Uint16Array(sandCanvas.width*sandCanvas.height);
   rakeBaseAlpha=new Uint8Array(sandCanvas.width*sandCanvas.height);
   repaintStoredRakes();
 }
 holder.appendChild(sandCanvas);holder.appendChild(liveRakeCanvas);
 foreign.appendChild(holder);
}
const SAND_BOUNDS={left:80,top:95,right:711,bottom:459};
function insideSand(p){return p.x>=SAND_BOUNDS.left&&p.x<=SAND_BOUNDS.right&&p.y>=SAND_BOUNDS.top&&p.y<=SAND_BOUNDS.bottom&&!inPond(p.x,p.y);}
// Liang-Barsky clips a pointer segment to the sand rectangle. The pointer can
// begin outside the sand, and only the portion over sand consumes energy.
function clipToSand(a,b){
 let t0=0,t1=1;
 const dx=b.x-a.x,dy=b.y-a.y;
 const edges=[[-dx,a.x-SAND_BOUNDS.left],[dx,SAND_BOUNDS.right-a.x],[-dy,a.y-SAND_BOUNDS.top],[dy,SAND_BOUNDS.bottom-a.y]];
 for(const [p,q] of edges){
   if(Math.abs(p)<1e-10){if(q<0)return null;continue;}
   const r=q/p;
   if(p<0)t0=Math.max(t0,r);else t1=Math.min(t1,r);
   if(t0>t1)return null;
 }
 return [{x:a.x+t0*dx,y:a.y+t0*dy},{x:a.x+t1*dx,y:a.y+t1*dy}];
}
// Remove redundant control points before we save a stroke. A small tolerance
// retains waves and loops while avoiding hundreds of points on straight lines.
// Douglas-Peucker operates on the path, not on individual sand ridges.
function simplifyRakePoints(points,tolerance=1.15){
 if(points.length<3)return points.map(p=>[p[0],p[1]]);
 const keep=new Uint8Array(points.length);keep[0]=1;keep[points.length-1]=1;
 const stack=[[0,points.length-1]],limit=tolerance*tolerance;
 while(stack.length){
  const [a,b]=stack.pop();let best=-1,bestDistance=limit;
  const x1=points[a][0],y1=points[a][1],dx=points[b][0]-x1,dy=points[b][1]-y1,denom=dx*dx+dy*dy;
  for(let i=a+1;i<b;i++){
   const p=points[i],t=denom?clamp(((p[0]-x1)*dx+(p[1]-y1)*dy)/denom,0,1):0;
   const ex=p[0]-x1-t*dx,ey=p[1]-y1-t*dy,d=ex*ex+ey*ey;
   if(d>bestDistance){best=i;bestDistance=d;}
  }
  if(best>=0){keep[best]=1;stack.push([a,best],[best,b]);}
 }
 return points.filter((_,i)=>keep[i]).map(p=>[+p[0].toFixed(2),+p[1].toFixed(2)]);
}
// A short, symmetric filter removes pointer jitter without flattening curves.
// Closed paths use a circular neighborhood. Open paths keep their endpoints.
function softenRakePoints(points,closed=false){
 const n=points.length;
 if(n<4)return points.map(p=>[p[0],p[1]]);
 const clean=closed&&Math.hypot(points[0][0]-points[n-1][0],points[0][1]-points[n-1][1])<.1?points.slice(0,-1):points;
 const total=clean.length;
 if(total<4)return clean.map(p=>[p[0],p[1]]);
 let result=clean.map(p=>[p[0],p[1]]);
 for(let pass=0;pass<2;pass++){
  const src=result;
  result=src.map((p,i)=>{
   if(!closed&&(i===0||i===total-1))return [...p];
   const before=src[(i-1+total)%total],after=src[(i+1)%total];
   return [p[0]*.60+(before[0]+after[0])*.20,p[1]*.60+(before[1]+after[1])*.20];
  });
 }
 return result;
}
function compactRakePoints(points,closed=false){
 // Simplify first, then filter, then simplify again. Preserve loop closure.
 if(!Array.isArray(points))return [];
 let usable=points.filter(p=>Array.isArray(p)&&Number.isFinite(p[0])&&Number.isFinite(p[1]));
 if(usable.length<2)return usable;
 let loop=closed&&usable.length>5;
 if(loop&&Math.hypot(usable[0][0]-usable.at(-1)[0],usable[0][1]-usable.at(-1)[1])<.1)usable=usable.slice(0,-1);
 let reduced=simplifyRakePoints(usable,.65);
 reduced=softenRakePoints(reduced,loop);
 reduced=simplifyRakePoints(reduced,1.2);
 if(loop&&reduced.length>=5)reduced.push([...reduced[0]]);
 return reduced;
}
function rakeCurvePoints(stroke){
 let points=stroke.points;
 if(!points||points.length<2)return null;
 const closed=!!stroke.closed&&points.length>=5;
 // Preview only: smooth a small amount without permanent point reduction.
 const softened=softenRakePoints(points,closed);
 const clean=closed&&Math.hypot(softened[0][0]-softened.at(-1)[0],softened[0][1]-softened.at(-1)[1])<.1?softened.slice(0,-1):softened;
 if(clean.length<2)return null;
 const out=[];
 for(let i=0;i<clean.length;i++){
  const p=clean[i],prev=clean[closed?(i-2+clean.length)%clean.length:Math.max(0,i-2)],
    next=clean[closed?(i+2)%clean.length:Math.min(clean.length-1,i+2)];
  let tx=next[0]-prev[0],ty=next[1]-prev[1],len=Math.hypot(tx,ty);
  if(len<.001){const a=clean[closed?(i-1+clean.length)%clean.length:Math.max(0,i-1)],b=clean[closed?(i+1)%clean.length:Math.min(clean.length-1,i+1)];tx=b[0]-a[0];ty=b[1]-a[1];len=Math.hypot(tx,ty);}
  if(len<.001){tx=1;ty=0;len=1;}
  out.push({x:p[0],y:p[1],nx:-ty/len,ny:tx/len});
 }
 return {points:out,closed};
}
// A quadratic curve follows the midpoint of adjacent controls. A single path
// handles each groove, so there are no circle stamps or cornered line segments.
function traceOffsetRake(ctx,points,offset,closed){
 const n=points.length,px=(i)=>points[i].x+points[i].nx*offset,py=(i)=>points[i].y+points[i].ny*offset;
 ctx.beginPath();
 if(closed){
  ctx.moveTo((px(n-1)+px(0))/2,(py(n-1)+py(0))/2);
  for(let i=0;i<n;i++){
   const j=(i+1)%n;
   ctx.quadraticCurveTo(px(i),py(i),(px(i)+px(j))/2,(py(i)+py(j))/2);
  }
  ctx.closePath();
 }else{
  ctx.moveTo(px(0),py(0));
  for(let i=1;i<n-1;i++)ctx.quadraticCurveTo(px(i),py(i),(px(i)+px(i+1))/2,(py(i)+py(i+1))/2);
  ctx.lineTo(px(n-1),py(n-1));
 }
}
function paintRakeStroke(ctx,stroke){
 if(!ctx||!stroke?.points||stroke.points.length<2)return;
 const depth=Number.isFinite(stroke.depth)?clamp(stroke.depth,0,1):1;
 if(depth<=0)return;
 const curve=rakeCurvePoints(stroke);
 if(!curve)return;
 const {points,closed}=curve;
 const rake=cfg.interaction.rake;
 // Narrow grooves keep adjacent passes easy to align. No outer dark rails.
 const width=rake.baseStrokeWidth+(state.upgrades.wideRake||0)*2.7;
 const count=rake.grooveCount||7;
 const spacing=width/(count+2);
 ctx.save();ctx.globalAlpha*=depth;ctx.lineCap='butt';ctx.lineJoin='round';
 // A quiet base relief makes the sand slightly lighter, without a hard rim.
 traceOffsetRake(ctx,points,0,closed);
 ctx.strokeStyle='rgba(216,196,161,.25)';ctx.lineWidth=spacing*(count+.5);ctx.stroke();
 for(let k=0;k<count;k++){
  const offset=(k-(count-1)/2)*spacing;
  traceOffsetRake(ctx,points,offset,closed);
  ctx.strokeStyle='rgba(113,84,52,.64)';ctx.lineWidth=.84;ctx.stroke();
  traceOffsetRake(ctx,points,offset+Math.min(.7,spacing*.28),closed);
  ctx.strokeStyle='rgba(255,244,218,.66)';ctx.lineWidth=.72;ctx.stroke();
 }
 ctx.restore();
}
// Raster brush: each sample replaces the older marks beneath its footprint.
// This prevents dark overlaps, including when a stroke crosses itself.
function rakeReplaceMode(){return (cfg.interaction.rake.overlapMode||'additive')==='replace';}
function rakeCurveSamples(stroke){
 const curve=rakeCurvePoints(stroke);
 if(!curve)return [];
 const pts=curve.points,closed=curve.closed,n=pts.length;
 const result=[];
 const append=(x,y)=>{
  const last=result.at(-1);
  if(!last||Math.hypot(x-last.x,y-last.y)>.45)result.push({x,y});
 };
 const segment=(a,b,c)=>{
  const approx=Math.hypot(a.x-b.x,a.y-b.y)+Math.hypot(b.x-c.x,b.y-c.y);
  const steps=Math.max(1,Math.ceil(approx/1.35));
  for(let i=1;i<=steps;i++){
   const t=i/steps,u=1-t;
   append(u*u*a.x+2*u*t*b.x+t*t*c.x,u*u*a.y+2*u*t*b.y+t*t*c.y);
  }
 };
 if(closed){
  const mid=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
  const first=mid(pts[n-1],pts[0]);append(first.x,first.y);
  for(let i=0;i<n;i++)segment(mid(pts[(i-1+n)%n],pts[i]),pts[i],mid(pts[i],pts[(i+1)%n]));
 } else {
  append(pts[0].x,pts[0].y);
  for(let i=1;i<n-1;i++){
   const a=i===1?pts[0]:{x:(pts[i-1].x+pts[i].x)/2,y:(pts[i-1].y+pts[i].y)/2};
   segment(a,pts[i],{x:(pts[i].x+pts[i+1].x)/2,y:(pts[i].y+pts[i+1].y)/2});
  }
  const last=result.at(-1),end=pts[n-1];
  if(last){const dist=Math.hypot(end.x-last.x,end.y-last.y);for(let i=1;i<=Math.max(1,Math.ceil(dist/1.35));i++)append(last.x+(end.x-last.x)*i/Math.max(1,Math.ceil(dist/1.35)),last.y+(end.y-last.y)*i/Math.max(1,Math.ceil(dist/1.35)));}
 }
 return result;
}
function rasterizeRake(data,stroke,ownerIndex=0,owners=null,bases=null){
 const pts=rakeCurveSamples(stroke);
 if(pts.length<2)return;
 const width=cfg.interaction.rake.baseStrokeWidth+(state.upgrades.wideRake||0)*2.7;
 const count=cfg.interaction.rake.grooveCount||7;
 const spacing=width/(count+2),half=(count+.72)*spacing/2;
 const depth=Number.isFinite(stroke.depth)?clamp(stroke.depth,0,1):1;
 const rgba=data.data,W=data.width,H=data.height;
 for(let k=0;k<pts.length;k++){
  const p=pts[k],before=pts[Math.max(0,k-1)],after=pts[Math.min(pts.length-1,k+1)];
  const dx=after.x-before.x,dy=after.y-before.y,len=Math.hypot(dx,dy)||1;
  const tx=dx/len,ty=dy/len,nx=-ty,ny=tx;
  const x=(p.x-SAND_BOUNDS.left)*2,y=(p.y-SAND_BOUNDS.top)*2;
  // Bound each sample by its rotated brush rectangle, not a large square.
  const extentX=2*(Math.abs(nx)*half+Math.abs(tx)*1.2)+1;
  const extentY=2*(Math.abs(ny)*half+Math.abs(ty)*1.2)+1;
  for(let yy=Math.max(0,Math.floor(y-extentY));yy<Math.min(H,Math.ceil(y+extentY));yy++){
   const wy=(yy+.5-y)*.5;
   for(let xx=Math.max(0,Math.floor(x-extentX));xx<Math.min(W,Math.ceil(x+extentX));xx++){
    const wx=(xx+.5-x)*.5;
    const along=wx*tx+wy*ty;
    if(Math.abs(along)>1.2)continue;
    const across=wx*nx+wy*ny;
    if(Math.abs(across)>half)continue;
    const idx=(yy*W+xx)*4;
    // One write wins: no alpha accumulation from old or crossing strokes.
    const offset=across-Math.round(across/spacing)*spacing;
    const dark=Math.exp(-Math.pow(offset/.44,2));
    const light=Math.exp(-Math.pow((offset-.69)/.52,2));
    const darkStrength=.62*dark,lightStrength=.47*light;
    const fade=Math.min(1,(half-Math.abs(across))/.5);
    const alpha=Math.round(255*Math.max(darkStrength,lightStrength)*fade);
    if(darkStrength>lightStrength){rgba[idx]=113;rgba[idx+1]=84;rgba[idx+2]=52;}
    else {rgba[idx]=255;rgba[idx+1]=244;rgba[idx+2]=218;}
    rgba[idx+3]=Math.round(alpha*depth);
    if(owners){owners[idx/4]=ownerIndex;bases[idx/4]=alpha;}
   }
  }
 }
}
function showRakeRaster(data){
 if(!sandContext||!data)return;
 sandContext.save();sandContext.setTransform(1,0,0,1,0,0);
 sandContext.putImageData(data,0,0);sandContext.restore();
}
function clearRakeLayer(ctx,canvas){
 if(!ctx||!canvas)return;
 ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.restore();
}
function repaintStoredRakes(){
 if(!sandContext)return;
 if(rakeReplaceMode()){
  rakeRaster.data.fill(0);rakeOwners.fill(0);rakeBaseAlpha.fill(0);
  state.rakeStrokes.forEach((stroke,i)=>{
   if(stroke!==dragging?.stroke)rasterizeRake(rakeRaster,stroke,i+1,rakeOwners,rakeBaseAlpha);
  });
  showRakeRaster(rakeRaster);
 }else{
  clearRakeLayer(sandContext,sandCanvas);
  for(const stroke of state.rakeStrokes)if(stroke!==dragging?.stroke)paintRakeStroke(sandContext,stroke);
 }
}
// Weather changes only opacity. Keep the direction and ownership of every pixel.
function refreshRakeDepth(){
 if(!sandContext)return;
 if(!rakeReplaceMode()){repaintStoredRakes();return;}
 const rgba=rakeRaster.data,strokes=state.rakeStrokes;
 for(let i=0;i<rakeOwners.length;i++){
  const owner=rakeOwners[i];
  if(!owner)continue;
  const depth=strokes[owner-1]?.depth??0;
  rgba[i*4+3]=Math.round(rakeBaseAlpha[i]*clamp(depth,0,1));
 }
 showRakeRaster(rakeRaster);
}
function scheduleLiveRake(){
 if(rakePaintQueued)return;
 rakePaintQueued=true;
 requestAnimationFrame((now)=>{
   rakePaintQueued=false;
   if(now-lastLivePaint<28){scheduleLiveRake();return;}
   lastLivePaint=now;
   if(rakeReplaceMode()){
    rakeLiveRaster.data.set(rakeRaster.data);
    if(dragging?.stroke)rasterizeRake(rakeLiveRaster,dragging.stroke);
    showRakeRaster(rakeLiveRaster);
   }else{
    clearRakeLayer(liveRakeContext,liveRakeCanvas);
    if(dragging?.stroke)paintRakeStroke(liveRakeContext,dragging.stroke);
   }
 });
}
function beginRakeStroke(p){
 if(state.energy<=0)return false;
 if(!dragging.started){scareBird();dragging.started=true;}
 const stroke={depth:1,points:[[+p.x.toFixed(2),+p.y.toFixed(2)]]};
 state.rakeStrokes.push(stroke);
 const max=cfg.interaction.rake.maxStoredStrokes||180;
 if(state.rakeStrokes.length>max){state.rakeStrokes.splice(0,state.rakeStrokes.length-max);repaintStoredRakes();}
 dragging.stroke=stroke;
 return true;
}
function commitRakeStroke(){
 if(!dragging?.stroke)return;
 const stroke=dragging.stroke;
 // A user who returns near the starting point has drawn a closed loop.
 if(stroke.points.length>12){
  const a=stroke.points[0],b=stroke.points.at(-1);
  stroke.closed=Math.hypot(a[0]-b[0],a[1]-b[1])<8;
 }
 if(stroke.points.length>=2){
  stroke.points=compactRakePoints(stroke.points,stroke.closed);
  if(!rakeReplaceMode())paintRakeStroke(sandContext,stroke);
 }
 else state.rakeStrokes=state.rakeStrokes.filter(mark=>mark!==stroke);
 dragging.stroke=null;
 if(rakeReplaceMode()){
  if(stroke.points.length>=2){
   rasterizeRake(rakeRaster,stroke,state.rakeStrokes.indexOf(stroke)+1,rakeOwners,rakeBaseAlpha);
  }
  showRakeRaster(rakeRaster);
 }
 clearRakeLayer(liveRakeContext,liveRakeCanvas);
}
function onDown(ev){
 if(ev.button!==0)return;
 const objectHit=ev.target.closest('[data-object-id]');
 if(objectHit){ev.preventDefault();pickup(objectHit.dataset.objectId);return;}
 if(state.energy<=0){flash('Your energy is low. Observe the garden.');return;}
 // Begin even on the patio, moss or stone border. Do not mark or consume energy
 // until the pointer crosses the sand. Pointer capture keeps the drag continuous.
 ev.preventDefault();
 dragging={pointer:ev.pointerId,lastPointer:screenPoint(ev),travel:0,stroke:null,started:false};
 $('gardenSvg').setPointerCapture(ev.pointerId);
}
function rakeMove(ev){
 if(!dragging||ev.pointerId!==dragging.pointer)return;
 ev.preventDefault();
 const events=typeof ev.getCoalescedEvents==='function'?ev.getCoalescedEvents():[];
 for(const sample of events.length?events:[ev]){
   if(!dragging)break;
   const p=screenPoint(sample),prev=dragging.lastPointer;
   dragging.lastPointer=p;
   const clipped=clipToSand(prev,p);
   if(!clipped||Math.hypot(clipped[1].x-clipped[0].x,clipped[1].y-clipped[0].y)<.001){
     if(!insideSand(p))commitRakeStroke();
     continue;
   }
   const [entry,exit]=clipped,b=cfg.interaction.rake;
   // Do not create a bridge across the patio after the pointer exits the sand.
   if(!dragging.stroke&& !beginRakeStroke(entry))break;
   const pts=dragging.stroke.points,last=pts.at(-1);
   if(Math.hypot(entry.x-last[0],entry.y-last[1])>2){
     commitRakeStroke();if(!beginRakeStroke(entry))break;
   }
   const d=Math.hypot(exit.x-entry.x,exit.y-entry.y);
   const perPixel=b.energyPer100Pixels/100*(1-(state.upgrades.steadyHands||0)*.08);
   const can=Math.min(d,state.energy/perPixel);
   if(can<.1){flash('Rest a little. The garden can wait.');finishRake();break;}
   const endpoint={x:entry.x+(exit.x-entry.x)*can/d,y:entry.y+(exit.y-entry.y)*can/d};
   const raw=dragging.stroke.points;
   if(Math.hypot(endpoint.x-raw.at(-1)[0],endpoint.y-raw.at(-1)[1])>=2.0){
     raw.push([+endpoint.x.toFixed(2),+endpoint.y.toFixed(2)]);
   } // Ignore subpixel jitter. The renderer joins the stored points smoothly.
   // Keep the stored path bounded without losing its shape.
   if(raw.length>1200){commitRakeStroke();beginRakeStroke(endpoint);}
   state.energy=clamp(state.energy-can*perPixel,0,100);
   state.world.sandDisturbance=Math.max(0,state.world.sandDisturbance-can*.055*(1+(state.upgrades.wideRake||0)*.17));
   state.experience+=can/100*b.experiencePer100Pixels;dragging.travel+=can;
   removeTracksUnderRake(entry,endpoint,b.trackEraseRadius*(1+(state.upgrades.wideRake||0)*.16));
   scheduleLiveRake();
   if(!insideSand(p))commitRakeStroke();
   if(can<d){flash('The rake stops. Your energy is empty.');finishRake();break;}
 }
 renderEnergy();
}
function finishRake(){
 if(!dragging)return;
 const drag=dragging;
 commitRakeStroke();dragging=null;
 try{$('gardenSvg').releasePointerCapture(drag.pointer);}catch(e){}
 if(drag.travel>1.5){state.manualActions++;note(`You raked ${Math.round(drag.travel)} units of sand.`);save();}
 renderScene();renderUI();
}
function onUp(ev){if(dragging&&dragging.pointer===ev.pointerId)finishRake();}
function distanceToSegment(px,py,x1,y1,x2,y2){const dx=x2-x1,dy=y2-y1,len=dx*dx+dy*dy,t=len?clamp(((px-x1)*dx+(py-y1)*dy)/len,0,1):0;return Math.hypot(px-(x1+t*dx),py-(y1+t*dy));}
function svg(tag,attrs={},parent,text){const el=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));if(text!=null)el.textContent=text;(parent||$('gardenSvg')).appendChild(el);return el;}
function path(d,stroke,width,parent,other={}){return svg('path',{d,fill:'none',stroke,'stroke-width':width,'stroke-linecap':'round',...other},parent);}
function sunInfo(){
 const h=hour(), daylight=h>=6&&h<18;
 const t=daylight?clamp((h-6)/12,0,1):((h-18+24)%24)/12;
 return {t,daylight,raining:state.weather.rainMinutes>0,height:Math.sin(Math.PI*t)};
}
function renderSky(){
 const sky=$('skySvg');sky.replaceChildren();
 const group=svg('g',{},sky),s=sunInfo();
 const background=s.raining?(s.daylight?'#dce3e0':'#485860'):(s.daylight?'#ecf2e8':'#1d3044');
 svg('rect',{x:0,y:0,width:800,height:58,rx:7,fill:background},group);
 path('M44 44 Q400 -28 756 44',s.daylight?'#c0d0bc':'#7a91a3',1.5,group,{'stroke-dasharray':'4 6',opacity:s.raining?.35:.65});
 const labelColor=s.daylight?'#87978c':'#bdc9cc';
 svg('text',{x:23,y:49,fill:labelColor,'font-size':10},group,'E');
 svg('text',{x:771,y:49,fill:labelColor,'font-size':10},group,'W');
 if(!s.daylight&&!s.raining){
  for(const [x,y] of [[160,12],[280,36],[520,15],[690,30],[370,8]])
   svg('circle',{cx:x,cy:y,r:.9,fill:'#c6d0d4',opacity:.72},group);
 }
 if(s.raining){
  for(const [x,y,sc] of [[350,22,1],[410,16,.7],[464,28,.7]]){
   const c=svg('g',{transform:`translate(${x} ${y}) scale(${sc})`},group);
   for(const [dx,dy,r] of [[-14,4,13],[0,-4,17],[17,5,12]])svg('circle',{cx:dx,cy:dy,r,fill:s.daylight?'#a6b5b4':'#849197'},c);
  }
 }else{
  const x=44+s.t*712,y=44-33*s.height;
  if(s.daylight){
   svg('circle',{cx:x,cy:y,r:9,fill:'#eec17b',stroke:'#f7e5b4','stroke-width':3,'data-celestial':'sun'},group);
  }else{
   const moon=svg('g',{transform:`translate(${x} ${y})`,'data-celestial':'moon'},group);
   svg('circle',{cx:0,cy:0,r:10,fill:'#e3e8df',stroke:'#c6d2d2','stroke-width':1.5},moon);
   svg('circle',{cx:-3,cy:-2,r:2.2,fill:'#b8c7c8',opacity:.55},moon);
   svg('circle',{cx:4,cy:3,r:1.4,fill:'#b8c7c8',opacity:.6},moon);
  }
 }
}
// Draw transient surface waves rather than synchronized rings with a fixed scale.
function wavePath(cx,cy,r,phase,ellipticity=.68){
 const vertices=45;let d='';
 for(let i=0;i<=vertices;i++){
  const a=2*Math.PI*i/vertices;
  const wobble=1+.037*Math.sin(a*5+phase*1.7)+.018*Math.sin(a*9-phase*.8);
  const x=cx+Math.cos(a)*r*wobble;
  const y=cy+Math.sin(a)*r*wobble*ellipticity;
  d+=(i?'L':'M')+x.toFixed(2)+' '+y.toFixed(2)+' ';
 }
 return d+'Z';
}
function waterHash(seed){
 const n=Math.sin(seed*127.1+31.7)*43758.5453123;
 return n-Math.floor(n);
}
function pondPoint(seed){
 const a=waterHash(seed+17)*Math.PI*2, r=Math.sqrt(waterHash(seed+83))*.89;
 return {x:649+Math.cos(a)*r*66,y:375+Math.sin(a)*r*56};
}
function paintWater(now){
 if(!rippleLayer)return;
 rippleLayer.replaceChildren();
 const t=now/1000,rain=state.weather.rainMinutes>0,light=phase()!=='night'?sunInfo().height:0;
 // Irregular capillary waves propagate from the stone water spout.
 // Highlights and shadow traces never share the same radius or opacity.
 for(let i=0;i<3;i++){
  const period=3.2+i*.52,age=(t+i*1.19)%period,p=age/period;
  if(p>.94)continue;
  const radius=2+76*Math.pow(p,.82),fade=Math.pow(1-p,2.0);
  const cx=652+Math.sin(t*.31+i)*1.7,cy=369+Math.cos(t*.41+i)*1.2;
  let wave=wavePath(cx,cy,radius,t*.72+i,.73);
  svg('path',{d:wave,fill:'none',stroke:'#f1f5ec','stroke-width':.50+fade*.68,opacity:(.06+.22*light)*fade},rippleLayer);
  wave=wavePath(cx+.5,cy+1,radius+.95,t*.72+i,.73);
  svg('path',{d:wave,fill:'none',stroke:'#0f3340','stroke-width':.68,opacity:.17*fade},rippleLayer);
 }
 // Animated surface flow combines thin broken highlights and dim troughs.
 for(let i=0;i<21;i++){
  const seed=i*19.8,y=318+(i*13.7)%116;
  const waveX=586+(i*23)%104+Math.sin(t*.37+seed)*4.0;
  const waveY=y+Math.sin(t*.58+i*2.3)*2.6;
  const len=7+(i*11)%25;
  const d=`M${waveX-len*.54} ${waveY.toFixed(2)} q${(len*.4).toFixed(2)} ${(-3-Math.cos(t*.6+i)*2).toFixed(2)} ${len.toFixed(2)} ${Math.sin(t*.53+i)*2}`;
  const dark=(i%4===0),faded=(.06+(i%6)*.014)*(dark?1:1+light*.7);
  svg('path',{d,stroke:dark?'#143f4b':'#dcebe3',fill:'none','stroke-linecap':'round',
    'stroke-width':dark?1.6:.65+(i%3)*.22,opacity:faded},rippleLayer);
 }
 // Moving caustic fragments suggest depth and sunlight without a bright pattern.
 if(light>.05&&!rain){
  for(let i=0;i<10;i++){
   const pos=pondPoint(i*8.9+2),s=Math.sin(t*.46+i*2.0),x=pos.x+s*3,y=pos.y+Math.cos(t*.38+i)*2;
   const intensity=.025+light*.075;
   svg('path',{d:`M${x-7} ${y} q5 ${-2-s} 12 ${1+s*.2}`,
     fill:'none',stroke:'#f7f4d9','stroke-width':.75,opacity:intensity},rippleLayer);
  }
 }
 // Each rain ripple gets a new but deterministic position for every cycle.
 // This prevents visible rows of repeating, identical circles.
 if(rain){
  for(let i=0;i<24;i++){
   const period=.62+(i%7)*.105,raw=t/period+i*1.73,cycle=Math.floor(raw),p=raw-cycle;
   const pos=pondPoint(i*53+cycle*17.6),radius=1+19*p;
   if(p>.92)continue;
   const fade=Math.pow(1-p,1.5),d=wavePath(pos.x,pos.y,radius,i*.89+p,.78);
   svg('path',{d,stroke:'#eaf1e7','stroke-width':.4+.3*fade,fill:'none',opacity:.25*fade},rippleLayer);
   if(p<.2)svg('ellipse',{cx:pos.x,cy:pos.y,rx:1.15,ry:.58,fill:'#e5f3eb',opacity:.38*(1-p*5)},rippleLayer);
  }
 }
 // Tiny highlights at the water entry point imply individual drops.
 const p=(t%1.06)/1.06;
 if(p<.24){
  svg('ellipse',{cx:652,cy:369,rx:1.5+p*9,ry:.8+p*4.5,fill:'none',stroke:'#eaf4ec',
    'stroke-width':.7,opacity:(1-p/.24)*.43},rippleLayer);
  if(p<.11)svg('circle',{cx:652,cy:365-6*(1-p/.11),r:1.25-p*3,fill:'#e4f3e5',opacity:.53},rippleLayer);
 }
}
// Every object keeps the same visual variant after a save/reload.
function spriteVariant(id,count){let h=2166136261;for(const c of String(id)){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return 1+(h>>>0)%count;}
// Preserve the camera-facing orientation of every loose object.
// Stable affine adjustments add variation without turning the baked artwork.
function groundSpriteTransform(ob){
 const v=cfg.assets?.groundSpritePlacement?.[ob.kind];
 if(!v||cfg.assets.groundSpritePlacement.mode==='original')return `translate(${ob.x} ${ob.y})`;
 const sample=(salt)=>{
  let h=2166136261;
  for(const ch of `${ob.kind}:${ob.id}:${salt}`){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}
  h^=h>>>16;h=Math.imul(h,0x7feb352d);h^=h>>>15;h=Math.imul(h,0x846ca68b);h^=h>>>16;
  return (h>>>0)/4294967295;
 };
 const pick=(pair,unit)=>pair[0]+(pair[1]-pair[0])*unit;
 const sx=pick(v.scaleX,sample('width'))*(v.mirrorX&&sample('mirror')>.5?-1:1);
 const sy=pick(v.scaleY,sample('height'));
 const skew=pick(v.shearX,sample('shear'));
 return `translate(${ob.x} ${ob.y}) matrix(${sx.toFixed(4)} 0 ${skew.toFixed(4)} ${sy.toFixed(4)} 0 0)`;
}

function spritePath(kind,id,count){return './sprites/'+kind+'_'+String(spriteVariant(id,count)).padStart(2,'0')+'.png';}
function imageSprite(parent,href,x,y,width,height,other={}){return svg('image',{href,x,y,width,height,preserveAspectRatio:'xMidYMid meet','pointer-events':'none',...other},parent);}
// Dimensions match the user's original rock PNGs. Keep the correct aspect ratio.
const ROCK_RATIOS=[564/964,447/861,667/863,403/735,500/1043,332/537,643/872];
// A stone needs a small contact shadow and a much softer projected shadow.
// The cast shadow flattens toward the ground and changes direction with the sun.
function placeRock(parent,stone,lighting){
 const {id,x,y,w,angle=0}=stone;
 const ratio=ROCK_RATIOS[(id-1)%ROCK_RATIOS.length],h=w*ratio;
 const href=`./sprites/rock_${pad(id)}.png`;
 const group=svg('g',{transform:`translate(${x} ${y})`,'pointer-events':'none'},parent);
 const light=lighting.sun;
 if(lighting.cast){
   const theta=(.5-light.t)*2;
   const distance=h*(.17+.35*(1-light.height));
   const dx=Math.sin(theta)*distance,dy=(.55-light.height)*h*.25+distance*.12;
   const cast=svg('g',{transform:`translate(${dx.toFixed(2)} ${dy.toFixed(2)}) scale(1 .32)`,opacity:clamp(.19+light.height*.16,.16,.35)},group);
   const shape=svg('g',{transform:`rotate(${angle})`},cast);
   imageSprite(shape,href,-w*.5,-h*.95,w,h,{filter:'url(#castRock)' });
 }
 // Contact remains visible in cloud, rain and night, but remains close to the rock.
 const body=svg('g',{transform:`rotate(${angle})`},group);
 svg('ellipse',{cx:0,cy:-h*.075,rx:w*.43,ry:Math.max(2,h*.13),fill:'#272c24',opacity:lighting.cast?.24:.12,filter:'url(#contactRock)'},body);
 // Tone slightly reduces the contrast between photographic stones and the ground.
 imageSprite(body,href,-w*.5,-h*.95,w,h,{style:'filter:saturate(.78) contrast(.94) brightness(.99)'});
 return group;
}

// The track layer updates independently from the complete patio scene.
function renderTracks(){
 if(!tracksGraphic||!state)return;
 tracksGraphic.replaceChildren();
 for(const m of state.footprints){
  const alpha=clamp(m.depth,0,1);
  if(alpha<=0)continue;
  const g=svg('g',{transform:`translate(${m.x} ${m.y}) rotate(${m.angle||0})`,opacity:alpha,'pointer-events':'none'},tracksGraphic);
  switch(m.type){
   case 'squirrel':
    svg('ellipse',{cx:0,cy:0,rx:2.4,ry:3.3,fill:'#604a30'},g);
    for(const [x,y] of [[-4,-4],[-1,-6],[3,-5],[5,-2]])svg('circle',{cx:x,cy:y,r:1.25,fill:'#604a30'},g);
    break;
   case 'snail':
    path('M-5 -1 Q-2 -2 0 1 T5 1','#826d50',2,g,{opacity:.8});
    path('M-5 3 Q-1 2 2 4 T5 4','#826d50',.7,g,{opacity:.55});
    break;
   case 'ant':
    for(const y of [-3,0,3])svg('circle',{cx:0,cy:y,r:.9,fill:'#3d3326'},g);
    break;
   default:
    path('M0 1 L-4 -4 M0 1 V-7 M0 1 L4 -4','#65513b',1.5,g);
  }
 }
 tracksDirty=false;
}
function renderScene(){
 const root=$('gardenSvg');root.replaceChildren();antCargoGraphic=null;
 birdGraphic=null;birdImage=null;squirrelGraphic=null;squirrelImage=null;snailGraphic=null;snailImage=null;antGraphic=null;tracksGraphic=null;
 birdFrame=-1;squirrelFrame=-1;snailFrame=-1;
 const night=phase()==='night',raining=state.weather.rainMinutes>0,si=sunInfo(),s=state.upgrades.wideRake||0;
 const defs=svg('defs',{},root);
 // Ground-level shadows stay attached to their stones instead of floating.
 const castFilter=svg('filter',{id:'castRock',x:'-45%',y:'-60%',width:'190%',height:'220%'},defs);
 svg('feColorMatrix',{type:'matrix',values:'0 0 0 0 .09  0 0 0 0 .10  0 0 0 0 .08  0 0 0 .75 0'},castFilter);
 svg('feGaussianBlur',{stdDeviation:2.6},castFilter);
 const contactFilter=svg('filter',{id:'contactRock',x:'-50%',y:'-100%',width:'200%',height:'300%'},defs);
 svg('feGaussianBlur',{stdDeviation:1.9},contactFilter);
 const showRockShadow=si.daylight&&!raining;
 const rockLighting={sun:si,cast:showRockShadow};
 const rockCastX=(.5-si.t)*28,rockCastY=(1-si.height)*12+6;
 const gradient=(id,stops,attrs={})=>{let g=svg('linearGradient',{id,x1:'0%',x2:'100%',y1:'0%',y2:'100%',...attrs},defs);for(const [offset,color,opacity] of stops)svg('stop',{offset,'stop-color':color,...(opacity==null?{}:{'stop-opacity':opacity})},g)};
 gradient('sandLight',[['0%','#fff7df',.30],['52%','#c6ac80',.08],['100%','#896b45',.16]]);
 const poolGradient=svg('radialGradient',{id:'wetPool',cx:'48%',cy:'52%',r:'52%'},defs);
 for(const [offset,opacity] of [['0%',.85],['38%',.75],['72%',.45],['100%',0]])
  svg('stop',{offset,'stop-color':cfg.interaction.sandWater.puddleColor,'stop-opacity':opacity},poolGradient);
 gradient('pondShade',[['0%','#b5c5b4',.28],['48%','#376775',.06],['100%','#132f3d',.45]]);
 gradient('stoneGrad',[['0%','#c5c2b2'],['35%','#96988d'],['68%','#777e75'],['100%','#565b56']]);
 gradient('rockGrad',[['0%','#c6c2ad'],['30%','#8e9589'],['100%','#5c6762']]);
 gradient('ambient',[['0%','#fff3cc',.22],['100%','#d1bd92',.03]]);
 const sandClip=svg('clipPath',{id:'sandClip'},defs);svg('rect',{x:80,y:95,width:631,height:364,rx:15},sandClip);
 const pondD='M580 346 C589 320 619 306 650 308 C696 304 719 330 723 355 C732 395 714 433 675 441 C631 452 583 430 578 402 C573 384 570 365 580 346 Z';
 const pc=svg('clipPath',{id:'pondClip'},defs);svg('path',{d:pondD},pc);
 const tex=(href,x,y,width,height,parent,other={})=>svg('image',{href,x,y,width,height,preserveAspectRatio:'xMidYMid slice','pointer-events':'none',...other},parent);
 const waterline=(x,y,rx,ry,op=.25)=>svg('ellipse',{cx:x,cy:y,rx,ry,stroke:'#e6f0e7','stroke-width':1.2,opacity:op,fill:'none','pointer-events':'none'});
 // Cedar veranda and handmade shoji screens. Every tree remains beyond the camera frame.
 svg('rect',{width:800,height:520,fill:'#aaa99a'},root);
 svg('rect',{x:0,y:0,width:800,height:80,fill:'#8c6649'},root);
 tex('./assets/cedar.webp',0,0,800,80,root,{opacity:.95});
 for(let i=0;i<6;i++){
   let x=7+i*133;
   svg('rect',{x,y:4,width:126,height:42,fill:'#50483b',rx:1,opacity:.75},root);
   svg('rect',{x:x+4,y:7,width:118,height:35,fill:'#eee6d7',stroke:'#b0a08b','stroke-width':1.5},root);
   for(let j=1;j<4;j++)path(`M${x+4+j*29.5} 8 V42`,'#8c7a66',1.8,root);
   path(`M${x+4} 23 H${x+122}`,'#8c7a66',1.6,root);
 }
 svg('rect',{x:0,y:46,width:800,height:30,fill:'#a17955',opacity:.56},root);
 for(let x=0;x<800;x+=90){path(`M${x} 47 V78`,'#624934',1.8,root,{opacity:.57});path(`M${x+2} 48 V74`,'#d5ab7b',.8,root,{opacity:.55});}
 svg('rect',{x:0,y:76,width:800,height:5,fill:'#544d40'},root);
 // Outer gravel, moss and organic stone border.
 svg('rect',{x:0,y:81,width:800,height:439,fill:'#66785e'},root);
 tex('./assets/moss.webp',0,81,800,439,root,{opacity:.96});
 svg('rect',{x:63,y:83,width:658,height:396,rx:24,fill:'#60685d',opacity:.45},root);
 svg('rect',{x:71,y:87,width:652,height:387,rx:20,fill:'#a5a292'},root);
 tex('./assets/stone.webp',70,84,656,394,root,{opacity:.60});
 svg('rect',{x:78,y:94,width:636,height:368,rx:17,fill:'#cbb68f',stroke:'#736f60','stroke-width':4},root);
 // Sand grain remains visible under the rake. Light shifts with the garden clock.
 const sand=svg('g',{'clip-path':'url(#sandClip)'},root);
 tex('./assets/sand.webp',79,94,635,367,sand);
 svg('rect',{x:80,y:95,width:631,height:364,fill:'url(#sandLight)','pointer-events':'none'},sand);
 // Moisture covers the sand, while standing water fills irregular low regions.
 // Do not render a water-drop sprite or individual collectible puddles.
 const wetness=state.weather.sandWetness||0,waterConfig=cfg.interaction.sandWater;
 if(wetness>.004)svg('rect',{x:80,y:95,width:631,height:364,fill:waterConfig.wetSandTint,
   opacity:Math.min(waterConfig.wetSandMaxOpacity,wetness*waterConfig.wetSandMaxOpacity),'pointer-events':'none'},sand);
 for(const low of state.puddleZones){
   if(low.depth<.025)continue;
   const points=12;let d='';
   for(let i=0;i<points;i++){
    const theta=i*2*Math.PI/points;
    const shift=1+.08*Math.sin(i*2.7+low.id*3)+.07*Math.cos(i*4.9+low.id*1.8);
    const x=low.x+Math.cos(theta)*low.rx*shift,y=low.y+Math.sin(theta)*low.ry*shift;
    d+=(i?' L':'M')+x.toFixed(1)+' '+y.toFixed(1);
   }
   d+=' Z';
   svg('path',{d,fill:'url(#wetPool)',opacity:low.depth*waterConfig.puddleMaxOpacity,
     'pointer-events':'none'},sand);
 }
 // Rake grooves remain visible through the moisture overlay.
 ensureSandCanvas(sand);
 // Tall trees are outside the frame. Their foliage projects moving shadows into the patio.
 if(si.daylight&&!raining){
  const shade=svg('g',{'pointer-events':'none',opacity:clamp(.14+si.height*.14,.11,.29)},sand),dx=(.5-si.t)*178,dy=(1-si.height)*62;
  for(const [cx,cy,scale,seed] of [[72+dx,148+dy,1.26,1],[733+dx,200+dy,1.14,3],[264+dx,491+dy,.86,8]]){
   const group=svg('g',{transform:`translate(${cx} ${cy}) rotate(${(si.t-.5)*24}) scale(${scale} ${.70+(1-si.height)*.22})`},shade);
   path('M1 83 Q-12 14 -3 -46 M-3 10 Q-40 -17 -77 -42 M-2 -9 Q42 -28 86 -46','#1d3831',9,group,{opacity:.7});
   for(let i=0;i<33;i++){
    const a=i*2.3999+seed*1.7,r=18+Math.sqrt(i/33)*87,cx2=Math.cos(a)*r,cy2=-36+Math.sin(a)*r*.66;
    const rr=17+(i*19%20);
    svg('ellipse',{cx:cx2,cy:cy2,rx:rr,ry:rr*.60,fill:'#253e33',opacity:.48+(i%4)*.11,transform:`rotate(${i*37%90} ${cx2} ${cy2})`},group);
   }
  }
 }
 // Three naturally sized stones are embedded in the sand.
 // Their PNGs keep their original proportions. The ground shadow touches each base.
 for(const stone of [
  {id:1,x:226,y:275,w:94,angle:-8},
  {id:3,x:272,y:300,w:53,angle:11},
  {id:6,x:454,y:214,w:86,angle:6}
 ])placeRock(sand,stone,rockLighting);
 // Pond, natural rim stones, reflected daylight, water grooves and a small stone spout.
 svg('path',{d:'M571 349 C579 311 616 296 651 296 C710 291 739 332 739 355 C752 419 716 456 672 457 C617 466 565 434 563 401 C558 378 565 365 571 349 Z',fill:'#716f62',opacity:.58},root);
 svg('path',{d:'M574 347 C580 314 615 298 650 299 C702 296 733 329 731 359 C739 407 714 449 671 451 C622 458 574 434 570 400 C565 378 565 366 574 347 Z',fill:'#a8a799',stroke:'#777c70','stroke-width':3},root);
 // The rim is an irregular collection of stones, not a uniform rock necklace.
 // Leave clear spaces for moss, water, and the fountain.
 const pondRim=[
  [1,581,344,33,-15],[4,595,319,23,12],[6,622,309,40,-8],
  [2,680,307,27,4],[7,708,323,35,14],[3,734,357,29,19],
  [6,729,401,42,-14],[5,710,435,30,10],[2,662,450,39,-17],
  [4,611,440,26,6],[1,571,412,34,-15],[7,560,378,27,20]
 ];
 for(const [id,x,y,w,angle] of pondRim)placeRock(root,{id,x,y,w,angle},rockLighting);
 const pond=svg('g',{'clip-path':'url(#pondClip)'},root);
 tex('./assets/water.webp',574,307,154,142,pond);
 svg('rect',{x:573,y:305,width:160,height:146,fill:'url(#pondShade)'},pond);
 for(let i=0;i<9;i++){
  let yy=325+i*13,xx=602+(i*37%78);
  path(`M${xx-21} ${yy} Q${xx} ${yy-5} ${xx+29} ${yy}`,'#d0e3dc',.7,pond,{opacity:.15+si.height*.10});
 }
 // Moving specular ripples use multiple interference circles and water highlights.
 // Keep the static water texture for depth; update only the ripple group between frames.
 rippleLayer=svg('g',{'pointer-events':'none'},pond);
 paintWater(performance.now());
 // The dark stone lip and spout cast small reflections over the moving surface.
 path('M649 364 Q647 355 654 345','#dce5dd',3.0,root,{opacity:.85});
 svg('ellipse',{cx:651,cy:370,rx:7,ry:3.5,fill:'#dce5d8',opacity:.25},root);
 svg('circle',{cx:654,cy:346,r:2.4,fill:'#f7f0d7'},root);
 // A few grounded stepping stones replace the old, evenly spaced rock row.
 // Leave the moss visible along most of the courtyard perimeter.
 for(const stone of [
  {id:5,x:115,y:510,w:71,angle:-4},
  {id:2,x:175,y:501,w:47,angle:8},
  {id:4,x:199,y:515,w:36,angle:-12},
  {id:6,x:489,y:503,w:54,angle:12},
  {id:7,x:534,y:512,w:63,angle:-6},
  {id:3,x:752,y:471,w:52,angle:-10}
 ])placeRock(root,stone,rockLighting);
 // Individual objects and generous invisible click targets.
 for(const ob of state.objects){
  if(antAgent?.cargo?.id===ob.id)continue;
  const g=svg('g',{'data-object-id':ob.id,role:'button',tabindex:'0','aria-label':`Collect ${ob.kind.slice(0,-1)}`,class:'garden-object',transform:groundSpriteTransform(ob)},sand);
  if(ob.kind==='leaves'){
   imageSprite(g,spritePath('leaf',ob.id,5),-13,-15,26,30);
  }else if(ob.kind==='branches'){
   imageSprite(g,spritePath('branch',ob.id,5),-26,-18,52,36);
  }else if(ob.kind==='nuts'){
   imageSprite(g,spritePath('nut',ob.id,3),-13,-13,26,26);
  }
  svg('circle',{cx:0,cy:0,r:ob.kind==='branches'?25:18,fill:'transparent',class:'object-hit'},g);
 }
 tracksGraphic=svg('g',{'pointer-events':'none'},sand);renderTracks();
 if(bird){const orient=bird.target?(bird.target.x-bird.x)>=0?1:-1:1;
  const b=svg('g',{transform:`translate(${bird.x} ${bird.y}) scale(${orient} 1)`,'pointer-events':'none'},sand);
  if(showRockShadow)svg('ellipse',{cx:1+rockCastX*.15,cy:9+rockCastY*.12,rx:15,ry:5,fill:'#433d2e',opacity:.19},b);
  birdGraphic=b;birdImage=imageSprite(b,'./sprites/bird_01.png',-23,-24,46,46);
 }
 if(squirrelAgent){
  const g=svg('g',{transform:`translate(${squirrelAgent.x} ${squirrelAgent.y})`,'pointer-events':'none'},sand);
  squirrelGraphic=g;
  if(showRockShadow)svg('ellipse',{cx:rockCastX*.2,cy:rockCastY*.25+9,rx:16,ry:6,fill:'#403d32',opacity:.20},g);
  squirrelImage=imageSprite(g,'./sprites/squirrel_01.png',-30,-33,60,60);
 }
 if(snailAgent){
   const g=svg('g',{transform:`translate(${snailAgent.x} ${snailAgent.y})`,'pointer-events':'none'},sand);
   snailGraphic=g;
   snailImage=imageSprite(g,'./sprites/snail_01.png',-19,-14,38,29);
 }
 if(antAgent){
  antGraphic=svg('g',{transform:`translate(${antAgent.x} ${antAgent.y})`,'pointer-events':'none'},sand);
  for(let i=0;i<6;i++)svg('ellipse',{cx:(i%3)*-5,cy:Math.floor(i/3)*4-2,r:1.2,fill:'#39382d',rx:1.5,ry:1},antGraphic);
  if(antAgent.cargo)antCargoGraphic=makeAntCargo(antGraphic,antAgent.cargo);
 }
 if(state.activity.dragonflyMinutes>0){path('M649 323 L652 342','#54878b',2.5,root);svg('ellipse',{cx:639,cy:328,rx:15,ry:4,fill:'#d6e5dc',opacity:.75,transform:'rotate(20 639 328)'},root);svg('ellipse',{cx:662,cy:328,rx:15,ry:4,fill:'#d6e5dc',opacity:.75,transform:'rotate(-20 662 328)'},root);}
 if(state.activity.fireflyMinutes>0&&night)for(let i=0;i<5;i++)svg('circle',{cx:607+i*24,cy:321+i%2*33,r:3,fill:'#efe99d',class:'firefly'},root);
 if(raining){
  svg('rect',{x:0,y:78,width:800,height:442,fill:'#8ea1ae',opacity:.12,'pointer-events':'none'},root);
  for(let i=0;i<43;i++){const x=83+(i*43)%620,y=107+(i*73)%350;path(`M${x} ${y} l-5 9`,'#c0d2d4',1.2,sand,{opacity:.33});}
 }
 // Wind removes rake depth; it does not create artificial lines on flat sand.
 if(si.daylight&&!raining){svg('rect',{x:0,y:80,width:800,height:440,fill:'#fff3d4',opacity:si.height*.045,'pointer-events':'none'},root);}
 if(night){svg('rect',{x:0,y:80,width:800,height:440,fill:'#14263a',opacity:.39,'pointer-events':'none'},root);}
 renderSky();
}

// Update only SVG transforms and sprite frames between ecosystem refreshes.
// Previously the game rebuilt the entire patio for each bird animation frame.
function animateWildlife(now){
 if(birdGraphic){
  if(!bird){birdGraphic.style.display='none';}
  else{
   birdGraphic.style.display='';
   const facing=bird.target&&bird.target.x<bird.x?-1:1;
   birdGraphic.setAttribute('transform',`translate(${bird.x.toFixed(2)} ${bird.y.toFixed(2)}) scale(${facing} 1)`);
   const frame=1+Math.floor(now/290)%7;
   if(frame!==birdFrame&&birdImage){birdImage.setAttribute('href',`./sprites/bird_${pad(frame)}.png`);birdFrame=frame;}
  }
 }
 if(squirrelImage&&squirrelGraphic&&squirrelAgent){
  squirrelGraphic.setAttribute('transform',`translate(${squirrelAgent.x.toFixed(2)} ${squirrelAgent.y.toFixed(2)}) scale(${squirrelAgent.heading>180?-1:1} 1)`);
  const frame=1+Math.floor(now/660)%7;
  if(frame!==squirrelFrame){squirrelImage.setAttribute('href',`./sprites/squirrel_${pad(frame)}.png`);squirrelFrame=frame;}
 }
 if(snailImage&&snailGraphic&&snailAgent){
  snailGraphic.setAttribute('transform',`translate(${snailAgent.x.toFixed(2)} ${snailAgent.y.toFixed(2)})`);
  const frame=1+Math.floor(now/950)%4;
  if(frame!==snailFrame){snailImage.setAttribute('href',`./sprites/snail_${pad(frame)}.png`);snailFrame=frame;}
 }
 if(antAgent&&antGraphic)antGraphic.setAttribute('transform',`translate(${antAgent.x.toFixed(2)} ${antAgent.y.toFixed(2)})`);
}

function renderEnergy(){$('energyLabel').textContent=`${Math.floor(state.energy)} / 100`;$('energyBar').style.width=`${state.energy}%`;}
function renderUI(){
 $('dayLabel').textContent=currentLanguage==='es'?`DÍA ${day()} DEL JARDÍN`:`GARDEN DAY ${day()}`;$('clockLabel').textContent=`${timeLabel()} · ${translateText(phase().replace(/^./,c=>c.toUpperCase()))}`;
 $('weatherLabel').textContent=translateText(state.weather.rainMinutes>0?'Rain · Wet sand':state.weather.windMinutes>0?'Wind':state.weather.sandWetness>.15?'Drying sand':phase()==='night'?'Quiet night':'Clear sky');
 $('game').classList.toggle('night',phase()==='night');renderEnergy();
 const speed=state.preferences.timeSpeed;for(const button of document.querySelectorAll('[data-speed]')){const selected=Number(button.dataset.speed)===speed;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));}
 $('timeContext').textContent=currentLanguage==='es'?`1 día del jardín = ${cfg.time.activeRealMinutesPerGardenDay/speed} minutos reales · El tiempo sin conexión no cambia`:`1 garden day = ${cfg.time.activeRealMinutesPerGardenDay/speed} real minutes · Offline time stays unchanged`;
 const metrics=[['Order',`${order()}%`],['Harmony',`${harmony()}%`],['Natural resolutions',state.naturalResolutions],['Your actions',state.manualActions]];
 $('metrics').replaceChildren(...metrics.map(([name,value])=>{let el=document.createElement('div');el.className='metric';let small=document.createElement('small'),strong=document.createElement('strong');small.textContent=translateText(name);strong.textContent=String(value);el.append(small,strong);return el;}));
 $('wallet').textContent=`${Math.floor(state.experience)} ${translateText('experience')} · ${state.insight} ${translateText('insight')}`;
 $('abilities').replaceChildren();let guide=document.createElement('div');guide.className='control-guide';guide.innerHTML=`<strong>${translateText('Hand rake')}</strong><small>${translateText('Drag from anywhere in the courtyard. Smooth curves and circles appear only on sand. Energy follows the distance over sand. Raking scares visiting birds away.')}</small>`;$('abilities').append(guide);
 const ritual=$('ritualBtn');ritual.disabled=state.dailyRitualDay===day();ritual.textContent=translateText(ritual.disabled?'Daily care complete':'Morning care · Restore energy');
 $('upgrades').replaceChildren(...cfg.upgrades.map(u=>{const lvl=state.upgrades[u.id],cost=u.cost+lvl*u.costIncrease;
  const row=document.createElement('div');row.className='upgrade';const info=document.createElement('div');info.className='upgrade-info';let name=document.createElement('strong');name.textContent=`${translateText(u.label)} · ${lvl}/${u.maxLevel}`;let desc=document.createElement('small');desc.textContent=translateText(u.description);info.append(name,desc);
  let button=document.createElement('button');button.textContent=lvl>=u.maxLevel?translateText('Max'):`${cost} ${u.currency==='experience'?'XP':translateText('insight')}`;button.disabled=lvl>=u.maxLevel||state[u.currency]<cost;button.addEventListener('click',()=>upgrade(u.id));row.append(info,button);return row;}));
 $('journal').replaceChildren(...state.journal.slice(0,cfg.insightDiscovery.visibleJournalEntries).map(r=>{
   const li=document.createElement('li');
   const time=document.createElement('span');time.className='time';time.textContent=r.time;
   // Every journal line offers the same control. Do not identify the insightful ones.
   const button=document.createElement('button');button.type='button';button.className='journal-entry';
   button.title=translateText('Read this event');
   button.setAttribute('aria-label',`${r.time}. ${translateText(r.message)}`);
   button.append(time,document.createTextNode(translateText(r.message)));
   if(r.observed){const badge=document.createElement('span');badge.className='noticed-hint';badge.textContent=translateText('Observed');button.append(badge);}
   button.addEventListener('click',()=>noticeInteraction(r.id));li.append(button);
   return li;
 }));
 $('discoveryCount').textContent=`${state.discoveries.length} / ${cfg.discoveries.length} ${translateText('discoveries')}`;
 $('discoveries').replaceChildren(...cfg.discoveries.map(d=>{let known=state.discoveries.includes(d.id),li=document.createElement('li'),name=document.createElement('strong');name.textContent=translateText(known?d.title:'A relationship remains unknown');li.append(name);if(known){let small=document.createElement('small');small.textContent=translateText(d.description);li.append(small);}else li.className='undiscovered';return li;}));
 $('leaveBtn').hidden=state.discoveries.length<cfg.ending.minDiscoveries||state.naturalResolutions<cfg.ending.minNaturalResolutions||order()<cfg.ending.minOrder;
}
function upgrade(id){const u=cfg.upgrades.find(x=>x.id===id),level=state.upgrades[id],cost=u.cost+level*u.costIncrease;if(level>=u.maxLevel||state[u.currency]<cost)return;state[u.currency]-=cost;state.upgrades[id]++;note(`You improved ${u.label.toLowerCase()}.`);flash(`${u.label} · level ${level+1}`);renderUI();save();}
function ritual(){if(state.dailyRitualDay===day())return;state.dailyRitualDay=day();state.energy=clamp(state.energy+cfg.dailyRitual.energyGain,0,100);state.experience+=cfg.dailyRitual.experienceGain;note('You completed the daily ritual. Nothing else is required.');flash('The daily ritual is complete.');renderUI();save();}
// The game always plays its bundled, user-supplied recordings.
async function getClip(context,key,file){
 const response=await fetch(file);
 if(!response.ok)throw Error('Cannot load '+file);
 return await context.decodeAudioData(await response.arrayBuffer());
}
async function createFountain(){
 const AC=window.AudioContext||window.webkitAudioContext;
 if(!AC)throw Error('The browser does not support Web Audio.');
 const context=new AC();
 try{
  const buffer=await getClip(context,'pond',cfg.audio.pondFountain.file);
  const gain=context.createGain();gain.gain.value=state.preferences.volume*.72;gain.connect(context.destination);
  const sources=[];
  for(const layer of cfg.audio.pondFountain.layers.slice(0,2)){
   const source=context.createBufferSource();source.buffer=buffer;source.loop=true;
   source.playbackRate.value=layer.playbackRate;
   const layerGain=context.createGain();layerGain.gain.value=layer.gain;
   source.connect(layerGain).connect(gain);
   source.start(0,layer.offsetSeconds%buffer.duration);
   sources.push({source,layerGain});
  }
  const audio={context,sources,gain,buffers:{},rainSource:null,windSources:[],activeCues:{birds:null,crickets:null},
    lastCue:{birds:0,crickets:0},nextCricketAt:Date.now()+rand(14000,26000),nextBirdAt:Date.now()+rand(9000,13000)};
  await Promise.all(Object.entries(cfg.audio.ambience).map(async ([key,info])=>{
   const files=info.files||(info.file?[info.file]:[]);
   const result=await Promise.all(files.map(async(file,index)=>{
    try {return await getClip(context,index===0?key:`${key}_${index}`,file);}
    catch(e){console.warn('Optional nature recording unavailable:',file,e);return null;}
   }));
   audio.buffers[key]=result.filter(Boolean);
  }));
  return audio;
 }catch(error){await context.close();throw error;}
}
function stopAmbientCue(kind){
 if(!fountain)return;
 const cue=fountain.activeCues[kind];
 if(!cue)return;
 const t=fountain.context.currentTime;
 cue.gain.gain.cancelScheduledValues(t);
 cue.gain.gain.setTargetAtTime(0,t,.08);
 try {cue.src.stop(t+.34);}catch(e){}
 fountain.activeCues[kind]=null;
}
function playAmbientCue(kind){
 if(!fountain||!state.preferences.fountainEnabled||document.hidden)return;
 if(kind==='birds'&&!bird)return;
 if(kind==='crickets'&&(phase()!=='night'||state.weather.rainMinutes>0))return;
 const audio=fountain, options=cfg.audio.ambience[kind],clips=audio.buffers[kind]||[];
 if(!options||!clips.length||audio.activeCues[kind])return;
 const now=Date.now(),minimum=kind==='birds'?3800:6500;
 if(now-audio.lastCue[kind]<minimum)return;
 const buffer=clips[Math.floor(Math.random()*clips.length)],context=audio.context;
 const duration=Math.min(buffer.duration-.15,rand(options.minCueSeconds||3,options.maxCueSeconds||6),kind==='birds'?bird.remaining:99);
 if(duration<.4)return;
 const source=context.createBufferSource(),localGain=context.createGain();
 source.buffer=buffer;source.playbackRate.value=kind==='birds'?rand(.96,1.04):rand(.98,1.02);
 const offset=rand(0,Math.max(0,buffer.duration-duration-.08));
 const level=options.gain*rand(.70,1.02),t=context.currentTime;
 localGain.gain.setValueAtTime(0,t);
 localGain.gain.linearRampToValueAtTime(level,t+.20);
 localGain.gain.setValueAtTime(level,t+Math.max(.21,duration-.5));
 localGain.gain.linearRampToValueAtTime(0,t+duration);
 source.connect(localGain).connect(audio.gain);
 audio.activeCues[kind]={src:source,gain:localGain};
 source.onended=()=>{if(audio.activeCues[kind]?.src===source)audio.activeCues[kind]=null;};
 source.start(t,offset,duration);
 audio.lastCue[kind]=now;
}
function startWeatherLoop(kind){
 const audio=fountain, config=cfg.audio.ambience[kind],clips=audio.buffers[kind]||[];
 if(!clips.length)return;
 const layers=kind==='wind'?Math.min(config.maxLayers||2,clips.length,2):1;
 const started=[];
 for(let i=0;i<layers;i++){
  const src=audio.context.createBufferSource(),g=audio.context.createGain(),t=audio.context.currentTime;
  src.buffer=clips[i];src.loop=true;
  src.playbackRate.value=i===0?1:.987;
  const level=config.gain*(i===0?1:(config.secondLayerGainRatio||.28));
  g.gain.setValueAtTime(0,t);
  g.gain.linearRampToValueAtTime(level,t+(config.fadeSeconds||1.5));
  src.connect(g).connect(audio.gain);
  src.start(t,i===0?0:Math.min(2.8,clips[i].duration*.2));
  started.push({src,g});
 }
 if(kind==='wind')audio.windSources=started;
 else audio.rainSource=started[0];
}
function fadeWeatherLoop(kind){
 if(!fountain)return;
 const audio=fountain,config=cfg.audio.ambience[kind],t=audio.context.currentTime;
 const sources=kind==='wind'?audio.windSources:(audio.rainSource?[audio.rainSource]:[]);
 for(const {src,g} of sources){
  g.gain.cancelScheduledValues(t);
  g.gain.setTargetAtTime(0,t,.28);
  try{src.stop(t+(config.fadeSeconds||1.5));}catch(e){}
 }
 if(kind==='wind')audio.windSources=[];
 else audio.rainSource=null;
}
function syncAmbience(){
 if(!fountain||!state.preferences.fountainEnabled||document.hidden)return;
 const audio=fountain,now=Date.now(), raining=state.weather.rainMinutes>0,windy=state.weather.windMinutes>0;
 if(raining&&!audio.rainSource)startWeatherLoop('rain');
 if(!raining&&audio.rainSource)fadeWeatherLoop('rain');
 if(windy&&!audio.windSources.length)startWeatherLoop('wind');
 if(!windy&&audio.windSources.length)fadeWeatherLoop('wind');
 if(phase()==='night'&&!raining&&now>=audio.nextCricketAt){
  playAmbientCue('crickets');
  audio.nextCricketAt=now+rand(cfg.audio.ambience.crickets.minSecondsBetween, cfg.audio.ambience.crickets.maxSecondsBetween)*1000;
 }else if(phase()!=='night'||raining){
  stopAmbientCue('crickets');
  audio.nextCricketAt=now+rand(9000,22000);
 }
 if(bird&&phase()!=='night'&&now>=audio.nextBirdAt){
  playAmbientCue('birds');
  audio.nextBirdAt=now+rand(cfg.audio.ambience.birds.minSecondsBetween, cfg.audio.ambience.birds.maxSecondsBetween)*1000;
 }else if(!bird)stopAmbientCue('birds');
}
async function toggleFountain(){
 state.preferences.fountainEnabled=!state.preferences.fountainEnabled;
 try{
  if(state.preferences.fountainEnabled){if(!fountain)fountain=await createFountain();await fountain.context.resume();syncAmbience();}
  else if(fountain){await fountain.context.suspend();}
 }catch(e){state.preferences.fountainEnabled=false;flash(e.message);}
 renderSound();save();
}
function renderSound(){
 $('fountainBtn').textContent=translateText(state.preferences.fountainEnabled?'♫ Ambient sound on':'♪ Start garden sounds');
 $('fountainBtn').classList.toggle('active',state.preferences.fountainEnabled);
 $('volume').value=Math.round(state.preferences.volume*100);
 if(fountain)fountain.gain.gain.value=state.preferences.volume*.72;
}

// This is a page-level focus view. Game time and controls continue unchanged.
function setGardenFocus(enabled){
 if(enabled&&document.activeElement?.id==='languageSelect')document.activeElement.blur();
 document.body.classList.toggle('garden-focus',Boolean(enabled));
 $('exitFocusBtn').hidden=!enabled;
 $('focusBtn').setAttribute('aria-pressed',String(Boolean(enabled)));
 try{localStorage.setItem('quiet-garden-focus-v1',enabled?'1':'0');}catch(e){}
}

function setTimeSpeed(speed){
 if(!cfg.time.playbackSpeeds.includes(speed))return;
 state.preferences.timeSpeed=speed;
 renderUI();save();
}
function exportSave(){let blob=new Blob([JSON.stringify({schemaVersion:cfg.schemaVersion,savedAt:Date.now(),state},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='quiet-garden-progress.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);}
async function importSave(file){if(!file||file.size>2000000){alert(translateText('Choose a progress file smaller than 2 MB.'));return;}try{let record=JSON.parse(await file.text());if(!validSave(record.state)||!Number.isFinite(record.savedAt))throw Error('Invalid garden save.');if(!confirm(translateText('Replace the current garden with this save?')))return;
 if(!migrate(record.state))throw Error('Unsupported saved data.');repaintStoredRakes();offlineAdvance(record.savedAt);bird=null;squirrelAgent=null;snailAgent=null;antAgent=null;tracksDirty=true;if(fountain)await fountain.context.suspend();state.preferences.fountainEnabled=false;renderSound();renderScene();renderUI();save();}catch(e){alert(`Import failed: ${e.message}`);}}
function reset(){if(!confirm(translateText('Start a new garden? This removes the saved local progress.')))return;try{localStorage.removeItem(SAVE_KEY);}catch(e){}nextId=1;state=initialState();reconcileObjects();repaintStoredRakes();bird=null;squirrelAgent=null;snailAgent=null;antAgent=null;tracksDirty=true;lastWall=Date.now();if(fountain)fountain.context.suspend();renderSound();renderScene();renderUI();save();}
function visibility(){if(document.hidden){if(dragging)finishRake();let elapsed=Math.max(0,Date.now()-lastWall);advance(Math.min(elapsed/60000*1440/cfg.time.activeRealMinutesPerGardenDay,30));lastWall=Date.now();if(fountain)fountain.context.suspend();save();bird=null;squirrelAgent=null;snailAgent=null;antAgent=null;}
 else{let record=loadSave();if(record){migrate(record.state);offlineAdvance(record.savedAt);}lastWall=Date.now();lastAnimation=0;accumulatedActiveMs=0;bird=null;squirrelAgent=null;snailAgent=null;antAgent=null;tracksDirty=true;state.activity.birdMinutes=0;for(const key of ['squirrelMinutes','snailMinutes','antMinutes'])state.activity[key]=0;if(fountain&&state.preferences.fountainEnabled)fountain.context.resume().then(syncAmbience).catch(()=>{});renderScene();renderUI();save();}}
function tick(now){requestAnimationFrame(tick);if(!cfg||!state||document.hidden)return;
 if(!lastAnimation)lastAnimation=now;const dt=Math.min((now-lastAnimation)/1000,.1);lastAnimation=now;
 const elapsed=Math.min(Date.now()-lastWall,30000);lastWall=Date.now();accumulatedActiveMs+=elapsed;
 // The visual bird moves every frame. The garden simulation advances every 400 ms.
 birdUpdate(dt*state.preferences.timeSpeed);
 wildlifeUpdate(dt*state.preferences.timeSpeed);
 animateWildlife(now);
 if(tracksDirty&&now-lastTracksPaint>95){renderTracks();lastTracksPaint=now;}
 if(now-lastUI>=400){
  advance(accumulatedActiveMs/60000*1440/cfg.time.activeRealMinutesPerGardenDay*state.preferences.timeSpeed);
  accumulatedActiveMs=0;
  if(!dragging&&now-lastScenePaint>=1500){renderScene();lastScenePaint=now;}
  renderSky();renderUI();syncAmbience();lastUI=now;
  if(Date.now()-lastSave>5000)save();
 }
 if(now-lastWaterPaint>70){paintWater(now);lastWaterPaint=now;}
}
async function init(){try{const res=await fetch('./garden.json',{cache:'no-cache'});if(!res.ok)throw Error(`HTTP ${res.status}`);cfg=await res.json();if(cfg.schemaVersion!==3)throw Error('Unsupported garden configuration.');}catch(e){const err=$('error');err.hidden=false;err.textContent=`Cannot load garden.json. Start a local HTTP server and open http://localhost:8000. ${e.message}`;return;}
 try{await preloadAssets();}
 catch(e){const err=$('error');err.hidden=false;err.textContent=`Could not prepare the garden artwork. ${e.message}`;$('assetLoading').hidden=true;return;}
 const record=loadSave();state=record?migrate(record.state):null;
 if(!state){state=initialState();reconcileObjects();}
 if(record)offlineAdvance(record.savedAt);
 state.preferences.fountainEnabled=false;state.activity.birdMinutes=0;
 for(const key of ['squirrelMinutes','snailMinutes','antMinutes'])state.activity[key]=0;
 lastWall=Date.now();
 $('game').hidden=false;staticLanguage();$('languageSelect').addEventListener('change',ev=>setLanguage(ev.target.value));$('focusBtn').addEventListener('click',()=>setGardenFocus(true));$('exitFocusBtn').addEventListener('click',()=>setGardenFocus(false));document.addEventListener('keydown',ev=>{if(ev.key==='Escape'&&document.body.classList.contains('garden-focus'))setGardenFocus(false);});try{setGardenFocus(localStorage.getItem('quiet-garden-focus-v1')==='1');}catch(e){setGardenFocus(false);}$('ritualBtn').addEventListener('click',ritual);$('fountainBtn').addEventListener('click',toggleFountain);
 $('volume').addEventListener('input',ev=>{state.preferences.volume=Number(ev.target.value)/100;if(fountain)fountain.gain.gain.value=state.preferences.volume*.72;save();});
 document.querySelectorAll('[data-speed]').forEach(button=>button.addEventListener('click',()=>setTimeSpeed(Number(button.dataset.speed))));
 $('resetBtn').addEventListener('click',reset);$('exportBtn').addEventListener('click',exportSave);
 $('importFile').addEventListener('change',ev=>{importSave(ev.target.files[0]);ev.target.value='';});
 $('leaveBtn').addEventListener('click',()=>{state.completed=true;save();$('endingDialog').showModal();});
 $('closeEndingBtn').addEventListener('click',()=>$('endingDialog').close());
 $('gardenSvg').addEventListener('pointerdown',onDown);$('gardenSvg').addEventListener('pointermove',rakeMove);
 $('gardenSvg').addEventListener('pointerup',onUp);$('gardenSvg').addEventListener('pointercancel',onUp);$('gardenSvg').addEventListener('lostpointercapture',ev=>{if(dragging&&ev.pointerId===dragging.pointer)finishRake();});
 $('gardenSvg').addEventListener('keydown',e=>{const target=e.target.closest('[data-object-id]');if(target&&(e.key==='Enter'||e.key===' ')){e.preventDefault();pickup(target.dataset.objectId);}});
 document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',()=>{save();});
 renderSound();renderScene();renderUI();save();requestAnimationFrame(tick);
}
init();

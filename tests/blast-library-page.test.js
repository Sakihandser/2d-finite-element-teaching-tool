const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const Settings=require('../blast-settings'),Explosives=require('../explosive-library'),Gas=require('../gas-library');
const explosives=require('../explosives/library.json'),gases=require('../gases/library.json');
function harness(kind){
  const elements=new Map(),current=Settings.normalize({sourceMode:0,productDensity:999,airDensity:1.7,x:.3,dt:1e-8});
  const element=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',closest(){return {hidden:false};}});return elements.get(id);};
  const context=vm.createContext({console,structuredClone,crypto:require('node:crypto').webcrypto,BlastSettings:Settings,ExplosiveLibrary:Explosives,GasLibrary:Gas,
    scene:{blastSettings:structuredClone(current)},document:{getElementById:element},saved:null});
  const root=path.resolve(__dirname,'..');
  for(const file of ['src/core/blast-dynamics.js','src/core/explosive-library-ui.js','src/core/gas-library-ui.js','src/pages/blast-library.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context);
  context.explosives=Explosives.normalize(structuredClone(explosives));context.gases=Gas.normalize(structuredClone(gases));context.kind=kind;
  vm.runInContext(`explosiveLibraryPayload=explosives;gasLibraryPayload=gases;blastLibraryKind=kind;
    blastLibraryDraft=structuredClone(blastLibraryRecords()[0]);blastLibraryId=blastLibraryDraft.id;
    for(const key of blastLibrarySchema().fields)document.getElementById('library-'+key).value=String(blastLibraryDraft.settings[key]/BLAST_FIELDS[key][1]);
    document.getElementById('blastLibraryName').value=blastLibraryDraft.name;
    document.getElementById('blastLibrarySource').value=blastLibraryDraft.source;
    document.getElementById('blastLibraryNotes').value=blastLibraryDraft.notes;
    document.getElementById('library-cjPressure').value=String((blastLibraryDraft.cjPressure || 0)/1e9);
    withBlastLibraryBusy=async action=>action();
    persistExplosiveLibrary=async records=>{saved=records;};persistGasLibrary=async records=>{saved=records;};
    openBlastLibraryRecord=record=>{blastLibraryId=record.id;};`,context);
  return {context,element,current};
}
for(const kind of ['explosive','gas'])test(`standalone ${kind} editor saves and copies its own draft without changing the simulation`,async()=>{
  const h=harness(kind),field=kind==='explosive'?'productDensity':'airDensity',value=kind==='explosive'?1333:1.8;
  h.element('library-'+field).value=String(value);h.element('blastLibraryName').value='Independent draft';
  await h.context.saveBlastLibraryDraft(false);
  assert.equal(h.context.saved.find(r=>r.name==='Independent draft').settings[field],value);
  assert.deepEqual(h.context.scene.blastSettings,h.current);
  const firstId=h.context.saved.find(r=>r.name==='Independent draft').id;
  await h.context.saveBlastLibraryDraft(true);assert.notEqual(h.context.saved.at(-1).id,firstId);
  assert.deepEqual(h.context.scene.blastSettings,h.current);
  h.element('library-'+field).value='';assert.throws(()=>h.context.readBlastLibraryDraft(),/Invalid/);
});

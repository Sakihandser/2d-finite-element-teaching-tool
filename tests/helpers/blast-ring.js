// Concentric, unrestrained plate with a real circular hole; SI units.
function blastRing({sectors=48,rings=10,outer=1}={}) {
  const props={elasticModulus:20e9,poissonRatio:.2,density:2500,tensileStrength:2e6,compressiveStrength:100e6};
  const nodes=[];
  for(let j=0;j<=rings;j++) for(let k=0;k<sectors;k++) {
    const r=.1+(outer-.1)*j/rings,angle=2*Math.PI*k/sectors,i=nodes.length;
    nodes.push({nodeNo:i+1,x:r*Math.cos(angle),y:r*Math.sin(angle),dofUx:2*i+1,dofUy:2*i+2,materialNo:1,regionNo:1});
  }
  const elements=[];
  for(let j=0;j<rings;j++) for(let k=0;k<sectors;k++) {
    const a=j*sectors+k,b=j*sectors+(k+1)%sectors,c=(j+1)*sectors+k,d=(j+1)*sectors+(k+1)%sectors;
    for(const ids of [[a,c,d],[a,d,b]]) {
      const [p,q,r]=ids.map(i=>nodes[i]);
      elements.push({...props,elementNo:elements.length+1,node1:p.nodeNo,node2:q.nodeNo,node3:r.nodeNo,
        nodeNumbers:ids.map(i=>i+1),area:Math.abs((q.x-p.x)*(r.y-p.y)-(r.x-p.x)*(q.y-p.y))/2,
        centroidX:(p.x+q.x+r.x)/3,centroidY:(p.y+q.y+r.y)/3,materialNo:1});
    }
  }
  return {modelName:"Circular cavity transient benchmark",units:{length:"m",force:"N",elasticModulus:"Pa",density:"kg/m3",strength:"Pa"},
    nodes,elements,materials:[{...props,materialNo:1}],elementNodeLoads:[]};
}
module.exports={blastRing};

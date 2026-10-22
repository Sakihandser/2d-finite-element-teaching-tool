// Shared browser/server settings; all solver inputs use SI units.
(function(root) {
  const defaults = Object.freeze({x:0,y:0,radius:.1,chargeRadius:.1,pressure:10e6,pulse:1e-4,duration:1e-3,
    dt:0,damping:0,gf:100,frames:61,fracture:true,boundary:0,loadMode:0,confineX:0,confineY:0,timeLimitSeconds:600,planeMode:0,
    sourceMode:0,productEOS:0,productDensity:1000,productEnergy:1e6,productGamma:1.3,detonationVelocity:2000,
    jwlA:0,jwlB:0,jwlR1:4.5,jwlR2:1.1,jwlOmega:.3,
    airDensity:1.2,airPressure:101325,airGamma:1.4,gasCells:192,
    rockModel:0,gasFracture:0,crackDamage:.95,kinematics:0,ventEnds:0,specimenThickness:.05,ventOpeningTime:0});
  function normalize(input={}) {
    const settings={...defaults,...input};
    if(input.chargeRadius===undefined)settings.chargeRadius=input.radius ?? defaults.radius;
    for(const key of Object.keys(defaults).filter(key=>key!=="fracture")) {
      if(typeof settings[key]!=="number" || !Number.isFinite(settings[key])) throw new Error(`Invalid blast setting: ${key}`);
    }
    if(typeof settings.fracture!=="boolean" || settings.radius<=0 || settings.chargeRadius<=0 || settings.pressure<0 || settings.pulse<=0 ||
      settings.duration<=0 || (settings.sourceMode===0 && settings.pulse>settings.duration) || settings.dt<0 || settings.damping<0 || settings.gf<=0 ||
      !Number.isInteger(settings.frames) || settings.frames<2 || settings.frames>201) throw new Error("Invalid blast radius, pressure, times, damage or frame count.");
    if(![0,1,2,3].includes(settings.boundary) || ![0,1].includes(settings.loadMode) || ![0,1].includes(settings.planeMode) || settings.confineX<0 || settings.confineY<0 ||
      settings.timeLimitSeconds<1 || settings.timeLimitSeconds>7200) throw new Error("Invalid blast boundary, confinement or time limit.");
    if(![0,1].includes(settings.sourceMode) || ![0,1,2].includes(settings.productEOS))throw new Error("Invalid gas source or EOS mode.");
    if(![0,1,2,3].includes(settings.rockModel) || ![0,1].includes(settings.gasFracture) || !(settings.crackDamage>0 && settings.crackDamage<=1))throw new Error('Invalid rock constitutive or fracture-storage setting.');
    if(![0,1].includes(settings.kinematics) || (settings.kinematics===1 && settings.planeMode!==1))throw new Error('Finite deformation currently requires plane strain.');
    if(![0,1,2].includes(settings.ventEnds) || !(settings.specimenThickness>0) || settings.ventOpeningTime<0)throw new Error('Invalid axial vent geometry or opening time.');
    if(settings.sourceMode===1 && (!(settings.productDensity>0) || !(settings.productEnergy>0) ||
      (settings.productEOS===0 && !(settings.productGamma>1 && settings.productGamma<=10)) ||
      (settings.productEOS===1 && (settings.jwlA<0 || settings.jwlB<0 || !(settings.jwlR1>0) || !(settings.jwlR2>0) ||
        !(settings.jwlOmega>0 && settings.jwlOmega<=9) || (settings.jwlA===0 && settings.jwlB===0))) ||
      !(settings.airDensity>0) || !(settings.airPressure>0) || !(settings.airGamma>1 && settings.airGamma<=2) ||
      !Number.isInteger(settings.gasCells) || settings.gasCells<16 || settings.gasCells>2048 ||
      (settings.productEOS===2 && (!(settings.detonationVelocity>0) ||
        !(Math.sqrt(1+settings.detonationVelocity**2/(2*settings.productEnergy))>1 && Math.sqrt(1+settings.detonationVelocity**2/(2*settings.productEnergy))<=10)))))throw new Error("Invalid gas/products parameters; JWL requires calibrated expansion coefficients.");
    return Object.fromEntries(Object.keys(defaults).map(key=>[key,settings[key]]));
  }
  const api={defaults,normalize};
  if(typeof module!=="undefined" && module.exports) module.exports=api;
  else root.BlastSettings=api;
})(typeof window!=="undefined" ? window : globalThis);

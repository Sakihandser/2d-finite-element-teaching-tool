// Synthetic numerical verification inputs, not calibrated material presets.
const cards={
  4:{j2:{yield:200e6,hardening:1e9}},
  5:{jc:{A:200e6,B:400e6,n:.4,C:.02,rate0:1,m:1,referenceTemperature:293,meltTemperature:1700,initialTemperature:293,heatCapacity:480,heatFraction:.9}},
  6:{mc:{cohesion:5e6,friction:30,dilation:5,tension:1e6}},
  7:{maxwell:{g1:.3,tau1:.02,g2:.2,tau2:.1,g3:0,tau3:0,g4:0,tau4:0}},
  8:{neoHookean:{shear:2e6,bulk:100e6}},
  9:{mcc:{M:1.2,lambda:.2,kappa:.04,voidRatio:.8,pc:200e6}},
  10:{cap:{cohesion:5e6,friction:30,dilation:5,pressure:20e6,aspect:2,hardening:500e6}},
  11:{perzyna:{yield:200e6,hardening:1e9,time:.001,exponent:2}},
  12:{orthotropic:{E1:100e9,E2:20e9,E3:10e9,nu12:.2,nu23:.1,nu13:.15,G12:8e9,G23:4e9,G13:5e9,angle:37}},
  13:{mooneyRivlin:{C10:.7e6,C01:.3e6,bulk:100e6}},
  14:{hjc:{A:.79,B:1.6,N:.61,C:.007,rate0:1,fc:48e6,T:4e6,maxStrength:7,D1:.04,D2:1,minFailureStrain:.001,crushPressure:16e6,crushVolume:.001,lockPressure:800e6,lockVolume:.1,K1:85e9,K2:-171e9,K3:208e9}}
};
function solidCard(law){return structuredClone({law,...cards[law]});}
function solidSettings(law){return [8,13].includes(law)?{kinematics:1,planeMode:1}:{};}
module.exports={solidCard,solidSettings};

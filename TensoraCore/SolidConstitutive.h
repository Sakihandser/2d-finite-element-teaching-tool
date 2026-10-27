#pragma once
// SOLID1 kernels. SI, tension-positive Cauchy stress, tensor shear strain.
// MC/MCC adapted to this interface with reference to CB-Geo (MIT); JC to
// Arcidiacono's VUMAT (MIT). Source snapshots/licenses: third_party/solid-reference.
// Algorithms, variant definitions and independent checks: docs/SOLID_CONSTITUTIVE.md.
#include <sstream>
#include <limits>

namespace fem { namespace rock {
using V6Solid=Eigen::Matrix<double,6,1>;
using M6Solid=Eigen::Matrix<double,6,6>;
inline int SolidCount(int law){const int count[]={0,0,0,0,2,11,4,8,2,5,6,4,10,3,18};return law>=0 && law<=14?count[law]:-1;}
inline void SolidRequire(bool yes,const char* message){if(!yes)throw std::runtime_error(message);}
inline V6Solid VoigtStrain(const Tensor& e){V6Solid v;v<<e(0,0),e(1,1),e(2,2),2*e(0,1),2*e(1,2),2*e(0,2);return v;}
inline V6Solid VoigtStress(const Tensor& e){V6Solid v;v<<e(0,0),e(1,1),e(2,2),e(0,1),e(1,2),e(0,2);return v;}
inline Tensor FromStress(const V6Solid& v){Tensor t;t<<v[0],v[3],v[5],v[3],v[1],v[4],v[5],v[4],v[2];return t;}
inline Tensor Orientation(double degrees){const double a=degrees*3.141592653589793/180,c=std::cos(a),s=std::sin(a);Tensor r;r<<c,-s,0,s,c,0,0,0,1;return r;}
inline void ReadSolid(std::istream& row,Parameters& p){
  if(p.law<4)return;std::string version;row>>version;SolidRequire(version=="SOLID1","Unsupported solid material card version.");
  p.solid.resize(SolidCount(p.law));for(auto& v:p.solid)SolidRequire(bool(row>>v)&&std::isfinite(v),"Malformed solid material parameters.");
}
inline void PrepareSolid(Parameters& p,bool finite,bool planeStrain,double rho){
  if(p.law<4)return;const auto& v=p.solid;
  SolidRequire(v.size()==SolidCount(p.law) && std::all_of(v.begin(),v.end(),[](double x){return std::isfinite(x);}),"Incomplete solid material parameters.");
  bool valid=true;
  if(p.law==4||p.law==11)valid=v[0]>0&&v[1]>=0&&(p.law==4||(v[2]>0&&v[3]>0));
  if(p.law==5)valid=v[0]>0&&v[1]>=0&&v[2]>0&&v[3]>=0&&v[4]>0&&v[5]>0&&v[6]>0&&v[7]>v[6]&&v[8]>=v[6]&&v[8]<v[7]&&v[9]>0&&v[10]>=0&&v[10]<=1&&rho>0;
  if(p.law==6)valid=v[0]>=0&&v[1]>=0&&v[1]<89&&v[2]>=0&&v[2]<=v[1]&&v[3]>=0&&(v[1]==0||v[3]<=v[0]/std::tan(v[1]*3.141592653589793/180));
  if(p.law==7){double sum=0;for(int i=0;i<4;i++){valid=valid&&v[2*i]>=0&&v[2*i+1]>=0&&(v[2*i]==0||v[2*i+1]>0);sum+=v[2*i];}valid=valid&&sum>0&&sum<1;}
  if(p.law==8)valid=v[0]>0&&v[1]>0;
  if(p.law==9)valid=v[0]>0&&v[1]>v[2]&&v[2]>0&&v[3]>0&&v[4]>0;
  if(p.law==10)valid=v[0]>0&&v[1]>=0&&v[1]<80&&v[2]>=0&&v[2]<=v[1]&&v[3]>0&&v[4]>0&&v[5]>=0;
  if(p.law==12){
    valid=v[0]>0&&v[1]>0&&v[2]>0&&v[6]>0&&v[7]>0&&v[8]>0;
    if(valid&&!p.orthotropic){M6Solid compliance=M6Solid::Zero();for(int i=0;i<3;i++)compliance(i,i)=1/v[i];
      compliance(0,1)=compliance(1,0)=-v[3]/v[0];compliance(1,2)=compliance(2,1)=-v[4]/v[1];compliance(0,2)=compliance(2,0)=-v[5]/v[0];
      compliance(3,3)=1/v[6];compliance(4,4)=1/v[7];compliance(5,5)=1/v[8];
      Eigen::LLT<M6Solid> check(compliance);valid=check.info()==Eigen::Success;
      if(valid)p.orthotropic=std::make_shared<M6Solid>(compliance.inverse());
    }
  }
  if(p.law==13)valid=v[0]>=0&&v[1]>=0&&v[0]+v[1]>0&&v[2]>0;
  if(p.law==14)valid=v[0]>0&&v[1]>=0&&v[2]>0&&v[3]>=0&&v[4]>0&&v[5]>0&&v[6]>0&&v[7]>0&&v[8]>0&&v[9]>=0&&v[10]>0&&v[11]>0&&v[12]>0&&v[13]>v[11]&&v[14]>v[12]&&(v[13]-v[11])/(v[14]-v[12])<v[11]/v[12]&&v[15]>=v[11]/v[12]&&v[17]>=0&&(v[17]>0||v[16]>=0)&&(v[16]>=0||v[15]-v[16]*v[16]/(3*v[17])>0);
  SolidRequire(valid,"Invalid solid constitutive parameters or nonpositive elastic compliance.");
  SolidRequire(!Hyperelastic(p)||(finite&&planeStrain),"Hyperelastic materials require finite deformation and plane strain.");
  SolidRequire(!(finite&&(p.law==7||p.law==9||p.law==12)),"Maxwell, MCC and orthotropic materials currently require small deformation.");
  // JC's density is internal to thermal integration, never a user-overridable duplicate.
  if(p.law==5)p.solid.push_back(rho);
  if(Hyperelastic(p)||p.law==14){const double G=Hyperelastic(p)?(p.law==8?v[0]:2*(v[0]+v[1])):p.G(),K=p.law==8?v[1]:p.law==13?v[2]:v[11]/v[12];p.E=9*K*G/(3*K+G);p.nu=(3*K-2*G)/(2*(3*K+G));}
}
inline Tensor ElasticIncrement(const Parameters& p,const Tensor& e){
  if(p.law==12){const Tensor r=Orientation(p.solid[9]);return r*FromStress((*p.orthotropic)*VoigtStrain(r.transpose()*e*r))*r.transpose();}
  return 2*p.G()*Dev(e)+p.K()*e.trace()*Tensor::Identity();
}
inline Eigen::Matrix3d PlaneStiffness(const Parameters& p,bool planeStrain){
  Eigen::Matrix<double,3,3> c;
  for(int j=0;j<3;j++){Tensor e=Tensor::Zero();if(j<2)e(j,j)=1;else e(0,1)=e(1,0)=.5;const Tensor t=ElasticIncrement(p,e);c.col(j)<<t(0,0),t(1,1),t(0,1);}
  if(!planeStrain){Tensor z=Tensor::Zero();z(2,2)=1;const Tensor t=ElasticIncrement(p,z);Eigen::Vector3d b(t(0,0),t(1,1),t(0,1));c-=b*b.transpose()/t(2,2);}
  return c;
}
template<class F>inline double Bisect(double lo,double hi,F function){
  SolidRequire(function(lo)>=-1e-8&&function(hi)<=1e-8,"Solid plastic return could not bracket a root.");
  for(int i=0;i<80;i++){const double mid=.5*(lo+hi);if(function(mid)>0)lo=mid;else hi=mid;}return .5*(lo+hi);
}
inline void J2Step(const Parameters& p,State& s,const Tensor& e,double dt){
  const auto& v=p.solid;const Tensor trial=s.stress+ElasticIncrement(p,e);const double q=Q(trial),G=p.G();double dep=0;
  auto yield=[&](double x){
    if(p.law!=5)return v[0]+v[1]*(s.plasticStrain+x);
    const double temp=std::clamp((s.temperature-v[6])/(v[7]-v[6]),0.,1.);
    return (v[0]+v[1]*std::pow(s.plasticStrain+x,v[2]))*(1+v[3]*std::log(std::max(1.,x/(dt*v[4]))))*(1-std::pow(temp,v[5]));
  };
  if(q>yield(0)){
    if(p.law==4)dep=(q-yield(0))/(3*G+v[1]);
    else if(p.law==11){
      // Solve dep = dt/tau <(q-3G dep - Y(ep+dep))/Y0>^n.
      dep=Bisect(0.,q/(3*G),[&](double x){return dt/v[2]*std::pow(std::max(0.,(q-3*G*x-yield(x))/v[0]),v[3])-x;});
    }else dep=Bisect(0.,q/(3*G),[&](double x){return q-3*G*x-yield(x);});
  }
  const double nextQ=std::max(0.,q-3*G*dep);s.stress=trial;if(q>0)s.stress=Dev(trial)*(nextQ/q)+trial.trace()/3*Tensor::Identity();
  const double work=nextQ*dep,old=s.plasticStrain;s.plasticStrain+=dep;
  if(p.law==5){const double volume=p.logarithmicVolume?std::exp((s.strain+e).trace()-s.initialVolumeStrain):1.;s.plasticWork+=work;s.temperature=std::min(v[7],s.temperature+v[10]*work*volume/(v[11]*v[9]));}
  else {const double stored=.5*v[1]*(s.plasticStrain*s.plasticStrain-old*old);s.hardeningEnergy+=stored;s.plasticWork+=std::max(0.,(nextQ-v[1]*s.plasticStrain)*dep);}
}
inline void MaxwellStep(const Parameters& p,State& s,const Tensor& e,double dt){
  const auto& v=p.solid;if(s.memory.empty())s.memory.resize(4,Tensor::Zero());
  const Tensor endDev=Dev(s.strain+e),rate=Dev(e)/dt;double sum=0;Tensor stress=Tensor::Zero();
  for(int i=0;i<4;i++)if(v[2*i]>0){
    const double Gi=p.G()*v[2*i],tau=v[2*i+1],decay=std::exp(-dt/tau),one=-std::expm1(-dt/tau);sum+=v[2*i];
    const Tensor steady=2*Gi*tau*rate,transient=s.memory[i]-steady;
    // Exact integral of q:q/(2 Gi tau), for piecewise constant strain rate.
    const double loss=steady.squaredNorm()*dt+2*tau*one*(steady.array()*transient.array()).sum()+.5*tau*(-std::expm1(-2*dt/tau))*transient.squaredNorm();
    s.plasticWork+=std::max(0.,loss/(2*Gi*tau));s.memory[i]=decay*s.memory[i]+2*Gi*tau*one*rate;stress+=s.memory[i];
  }
  s.stress=stress+2*p.G()*(1-sum)*endDev+p.K()*(s.strain+e).trace()*Tensor::Identity();
}
inline void MCStep(const Parameters& p,State& s,const Tensor& e){
  const auto& v=p.solid;const Tensor trial=s.stress+ElasticIncrement(p,e);Eigen::SelfAdjointEigenSolver<Tensor> eig(trial);SolidRequire(eig.info()==Eigen::Success,"MC principal stress decomposition failed.");
  const double phi=std::sin(v[1]*3.141592653589793/180),psi=std::sin(v[2]*3.141592653589793/180),cohesion=2*v[0]*std::sqrt(1-phi*phi);
  Eigen::Matrix3d C=Eigen::Matrix3d::Constant(p.K()-2*p.G()/3);C.diagonal().array()+=2*p.G();
  std::vector<Eigen::Vector3d> normals,flows;std::vector<double> intercepts;
  for(int i=0;i<3;i++)for(int j=0;j<3;j++)if(i!=j){Eigen::Vector3d n=Eigen::Vector3d::Zero(),g=n;n[i]=1+phi;n[j]=-1+phi;g[i]=1+psi;g[j]=-1+psi;normals.push_back(n);flows.push_back(g);intercepts.push_back(cohesion);}
  for(int i=0;i<3;i++){normals.push_back(Eigen::Vector3d::Unit(i));flows.push_back(Eigen::Vector3d::Unit(i));intercepts.push_back(v[3]);}
  const Eigen::Vector3d t=eig.eigenvalues();Eigen::Vector3d result=t,plastic=Eigen::Vector3d::Zero();bool found=false;
  auto admissible=[&](const Eigen::Vector3d& x){for(int i=0;i<9;i++)if(normals[i].dot(x)-intercepts[i]>1e-7*std::max({1.,v[0],trial.norm()}))return false;return true;};
  if(admissible(t))return void(s.stress=trial);
  // Enumerate up to three active planes: smooth face, shear edge and apex,
  // including mixed shear/tension corners. No DP cone approximation.
  for(int count=1;count<=3&&!found;count++)for(int mask=1;mask<(1<<9)&&!found;mask++){
    int bits=0;for(int j=0;j<9;j++)if(mask&(1<<j))bits++;if(bits!=count)continue;
    Eigen::MatrixXd N(3,count),P(3,count);Eigen::VectorXd b(count);int k=0;
    for(int j=0;j<9;j++)if(mask&(1<<j)){N.col(k)=normals[j];P.col(k)=flows[j];b[k]=normals[j].dot(t)-intercepts[j];k++;}
    const Eigen::MatrixXd a=N.transpose()*C*P;Eigen::FullPivLU<Eigen::MatrixXd> lu(a);if(!lu.isInvertible())continue;
    const Eigen::VectorXd multipliers=lu.solve(b);if(multipliers.minCoeff()<-1e-12)continue;
    const Eigen::Vector3d ep=P*multipliers,candidate=t-C*ep;if(!admissible(candidate))continue;
    result=candidate;plastic=ep;found=true;
  }
  SolidRequire(found,"MC active-surface return did not converge; reduce the strain increment.");
  s.stress=eig.eigenvectors()*result.asDiagonal()*eig.eigenvectors().transpose();s.plasticStrain+=std::sqrt(2./3*(plastic.array()-plastic.mean()).matrix().squaredNorm());s.plasticVolume-=plastic.sum();s.plasticWork+=std::max(0.,result.dot(plastic));
}
inline void MCCStep(const Parameters& p,State& s,const Tensor& e){
  // Constant-elasticity MCC variant. Lambda/kappa control pc hardening, not an
  // implicit change of the user's specified E/nu. See documentation.
  const auto& v=p.solid;const Tensor trial=s.stress+ElasticIncrement(p,e);const double pt=-trial.trace()/3,qt=Q(trial),M2=v[0]*v[0],K=p.K(),G=p.G(),pc0=s.pc>0?s.pc:v[4];
  SolidRequire(pt>0,"MCC requires positive effective pressure; tensile states are unsupported.");
  if(qt*qt+M2*pt*(pt-pc0)<=1e-10*std::max(pc0*pc0,1.)){s.stress=trial;return;}
  const double specific=(1+v[3])*std::exp((s.strain+e).trace()-s.initialVolumeStrain),hard=specific/(v[1]-v[2]);
  auto at=[&](double multiplier){
    // For fixed multiplier, implicit exponential hardening is monotone in pc.
    auto pressure=[&](double pc){return (pt+multiplier*K*M2*pc)/(1+2*multiplier*K*M2);};
    double lo=-100,hi=std::min(100.,hard*pt/K),y=0;
    for(int i=0;i<40;i++){const double pc=pc0*std::exp(y),pp=pressure(pc),f=y-hard*(pt-pp)/K;
      if(std::abs(f)<1e-13)break;if(f>0)hi=y;else lo=y;
      const double derivative=1+hard*multiplier*M2*pc/(1+2*multiplier*K*M2),next=y-f/derivative;
      y=next>lo&&next<hi?next:.5*(lo+hi);
    }
    const double pc=pc0*std::exp(y),pp=pressure(pc),qq=qt/(1+6*G*multiplier);return Eigen::Vector3d(pp,qq,pc);
  };
  double hi=1/std::max(K,G);for(int i=0;i<100;i++){const auto a=at(hi);if(a[1]*a[1]+M2*a[0]*(a[0]-a[2])<=0)break;hi*=2;}
  const double mult=Bisect(0.,hi,[&](double x){auto a=at(x);return (a[1]*a[1]+M2*a[0]*(a[0]-a[2]))/(pc0*pc0);});const auto a=at(mult);
  const double dep=(qt-a[1])/(3*G),dvol=(pt-a[0])/K;s.pc=a[2];s.plasticVolume+=dvol;s.plasticStrain+=dep;s.plasticWork+=std::max(0.,a[0]*dvol+a[1]*dep);
  s.stress=(qt>0?Dev(trial)*(a[1]/qt):Tensor::Zero().eval())-a[0]*Tensor::Identity();
}
inline void CapStep(const Parameters& p,State& s,const Tensor& e){
  const auto& v=p.solid;const double alpha=std::tan(v[1]*3.141592653589793/180),flow=std::tan(v[2]*3.141592653589793/180),R=v[4],K=p.K(),G=p.G();
  const Tensor trial=s.stress+ElasticIncrement(p,e);const double pt=-trial.trace()/3,qt=Q(trial),pa0=s.pc>0?s.pc:v[3];double pp=pt,qq=qt,dvol=0,dep=0;
  if(pt<=pa0){
    const double yield=v[0]+alpha*pt;
    if(qt>yield){dep=std::max(0.,(qt-yield)/(3*G+alpha*K*flow));
      // At the tensile cone tip q=0: include volumetric return instead of
      // permitting a hydrostatic tensile state outside the DP domain.
      if(dep*3*G>qt){dep=qt/(3*G);pp=alpha>0?-v[0]/alpha:pt;dvol=(pt-pp)/K;qq=0;}
      else {qq=qt-3*G*dep;pp=pt+K*flow*dep;dvol=-flow*dep;}
      if(pp>pa0){pp=pa0;qq=v[0]+alpha*pa0;dep=std::max(0.,(qt-qq)/(3*G));dvol=(pt-pp)/K;}
    }
  }else {
    const double b0=v[0]+alpha*pa0;
    if((pt-pa0)*(pt-pa0)/(R*R)+qt*qt>b0*b0){
      // Implicit associated cap return; pa hardens only under compaction.
      auto at=[&](double l){const double a=2*l/(R*R);const double pa=(pa0*(1+a*K)+a*v[5]*pt)/(1+a*(K+v[5]));const double pressure=(pt+a*K*pa)/(1+a*K);return Eigen::Vector3d(pressure,qt/(1+6*l*G),pa);};
      auto f=[&](double l){auto a=at(l);const double b=v[0]+alpha*a[2];return ((a[0]-a[2])*(a[0]-a[2])/(R*R)+a[1]*a[1]-b*b)/(b0*b0);};
      double hi=1/std::max(G,K);for(int i=0;i<100&&f(hi)>0;i++)hi*=2;
      const auto a=at(Bisect(0.,hi,f));pp=a[0];qq=a[1];dvol=(pt-pp)/K;dep=(qt-qq)/(3*G);
    }
  }
  s.pc=pa0+v[5]*std::max(0.,dvol);s.plasticVolume+=dvol;s.plasticStrain+=dep;s.plasticWork+=std::max(0.,pp*dvol+qq*dep);
  s.stress=(qt>0?Dev(trial)*(qq/qt):Tensor::Zero().eval())-pp*Tensor::Identity();
}
inline double HJCEnvelope(const Parameters& p,double mu){
  const auto& v=p.solid;
  if(mu<=v[12])return v[11]/v[12]*mu;
  if(mu<=v[14])return v[11]+(v[13]-v[11])*(mu-v[12])/(v[14]-v[12]);
  const double z=(mu-v[14])/(1+v[14]);return v[13]+((v[17]*z+v[16])*z+v[15])*z;
}
inline double HJCBulk(const Parameters& p,double mu){const auto& v=p.solid;const double t=std::clamp((mu-v[12])/(v[14]-v[12]),0.,1.);return (1-t)*v[11]/v[12]+t*v[15];}
inline double HJCWaveBound(const Parameters& p,double mu){const auto& v=p.solid;const double z=std::max(0.,(mu-v[14])/(1+v[14]));return (1+mu)*std::max({v[11]/v[12],v[15],(v[13]-v[11])/(v[14]-v[12]),(v[15]+2*v[16]*z+3*v[17]*z*z)/(1+v[14])});}
inline double HyperWaveBound(const Parameters& p,const Tensor& F){const double J=F.determinant();const auto& v=p.solid;const double K=p.law==8?v[1]:v[2],c10=p.law==8?.5*v[0]:v[0],c01=p.law==8?0:v[1];const double b=std::pow(J,-2./3)*F.squaredNorm();return K*std::max(1.,2*J)+8*(c10*b+c01*b*b)/J;}
inline double HJCStrength(const Parameters& p,double pressure,double rate,double damage){const auto& v=p.solid;const double factor=1+v[3]*std::log(std::max(1.,rate/v[4]));const double strength=pressure>=0?v[0]*(1-damage)+v[1]*std::pow(pressure/v[5],v[2]):v[0]*(1-damage)*std::max(0.,1+pressure/v[6]);return v[5]*std::min(v[7],strength*factor);}
inline void HJCStep(const Parameters& p,State& s,const Tensor& e,double dt,bool damage){
  const auto& v=p.solid;const double trace=(s.strain+e).trace();SolidRequire(p.logarithmicVolume||trace>-.8,"HJC volume collapsed; reduce the strain increment.");
  const double mu=p.logarithmicVolume?std::expm1(-trace):-trace/(1+trace),oldMax=s.maxCompression;
  const double peak=std::max(oldMax,mu),bulk=HJCBulk(p,peak),envelope=HJCEnvelope(p,peak);
  const double compact=std::min(peak,v[14]);
  double pp=envelope-bulk*(peak-mu)+bulk*s.tensileOpening;const double plastic=std::max(0.,compact-HJCEnvelope(p,compact)/bulk),dvol=std::max(0.,plastic-s.plasticVolume);
  s.maxCompression=peak;s.plasticVolume=std::max(s.plasticVolume,plastic);
  const Tensor trial=Dev(s.stress)+2*p.G()*Dev(e);const double qt=Q(trial),rate=std::sqrt(2./3*Dev(e).squaredNorm())/dt;
  const double failure=std::max(v[10],v[8]*std::pow(std::max(0.,(pp+v[6])/v[5]),v[9])),oldDamage=s.damage;
  if(damage)s.damage=std::min(1.,s.damage+dvol/failure);
  double dep=0;if(qt>HJCStrength(p,pp,rate,s.damage)){
    // Damage-softening radial return, bracketed across the full plastic range.
    auto residual=[&](double x){const double d=damage?std::min(1.,s.damage+x/failure):s.damage;return qt-3*p.G()*x-HJCStrength(p,pp,rate,d);};
    double lo=0,hi=qt/(3*p.G());for(int i=0;i<80;i++){const double mid=.5*(lo+hi);if(residual(mid)>0)lo=mid;else hi=mid;}dep=.5*(lo+hi);
    if(damage)s.damage=std::min(1.,s.damage+dep/failure);
  }
  const double cut=-(1-s.damage)*v[6];if(pp<cut){
    const double denominator=bulk-(damage?v[6]/failure:0),candidate=denominator>0?(cut-pp)/denominator:-1;
    const double opening=candidate>=0&&(!damage||candidate<=(1-s.damage)*failure)?candidate:std::max(0.,-pp/bulk);
    if(damage)s.damage=std::min(1.,s.damage+opening/failure);
    const double capped=-(1-s.damage)*v[6];s.tensileOpening+=opening;s.plasticWork+=std::max(0.,-.5*(pp+capped)*opening);pp=capped;
  }
  double qq=std::max(0.,qt-3*p.G()*dep);qq=std::min(qq,HJCStrength(p,pp,rate,s.damage));
  s.plasticStrain+=dep;s.plasticWork+=std::max(0.,qq*dep+std::max(0.,pp)*dvol);s.stress=(qt>0?trial*(qq/qt):Tensor::Zero().eval())-pp*Tensor::Identity();
  s.solidEnergy=std::max(0.,pp*pp/(2*bulk))+Dev(s.stress).squaredNorm()/(4*p.G());
}
inline State AdvanceHyperelastic(const Parameters& p,const State& old,const Tensor& F){
  State s=old;const double J=F.determinant();SolidRequire(J>1e-4&&F.allFinite(),"Hyperelastic deformation gradient is inverted or collapsed.");
  const auto& v=p.solid;const double c10=p.law==8?.5*v[0]:v[0],c01=p.law==8?0:v[1],K=p.law==8?v[1]:v[2];
  const Tensor b=std::pow(J,-2./3)*(F*F.transpose());const double i1=b.trace(),i2=.5*(i1*i1-(b*b).trace());
  s.stress=(2*c10*Dev(b)+2*c01*Dev(i1*b-b*b))/J+K*(J-1)*Tensor::Identity();s.effective=s.stress;
  s.solidEnergy=c10*(i1-3)+c01*(i2-3)+.5*K*(J-1)*(J-1);
  Eigen::SelfAdjointEigenSolver<Tensor> eig(F*F.transpose());SolidRequire(eig.eigenvalues().minCoeff()>0,"Hyperelastic stretch is nonpositive.");s.strain=.5*eig.eigenvectors()*eig.eigenvalues().array().log().matrix().asDiagonal()*eig.eigenvectors().transpose();return s;
}
inline void SolidStep(const Parameters& p,State& s,const Tensor& e,double dt,bool damage){
  SolidRequire(dt>0&&e.allFinite(),"Solid update requires a finite strain increment and positive time step.");
  if(p.law==4||p.law==5||p.law==11)J2Step(p,s,e,dt);
  else if(p.law==6)MCStep(p,s,e);
  else if(p.law==7)MaxwellStep(p,s,e,dt);
  else if(p.law==9)MCCStep(p,s,e);
  else if(p.law==10)CapStep(p,s,e);
  else if(p.law==12)s.stress+=ElasticIncrement(p,e);
  else if(p.law==14)HJCStep(p,s,e,dt,damage);
  else throw std::runtime_error("Hyperelastic updates require the total deformation gradient.");
  s.strain+=e;s.effective=s.stress;SolidRequire(s.stress.allFinite()&&std::isfinite(s.plasticWork)&&std::isfinite(s.temperature),"Non-finite solid state; check parameters and time step.");
}
inline double SolidStoredEnergy(const Parameters& p,const State& s){
  if(Hyperelastic(p)||p.law==14)return std::max(0.,s.solidEnergy);
  if(p.law==12){const Tensor r=Orientation(p.solid[9]);const V6Solid stress=VoigtStress(r.transpose()*s.stress*r);return .5*stress.dot(p.orthotropic->ldlt().solve(stress));}
  if(p.law==7){double sum=0,energy=0;for(int i=0;i<4;i++)if(p.solid[2*i]>0){sum+=p.solid[2*i];if(!s.memory.empty())energy+=s.memory[i].squaredNorm()/(4*p.G()*p.solid[2*i]);}return energy+p.G()*(1-sum)*Dev(s.strain).squaredNorm()+.5*p.K()*s.strain.trace()*s.strain.trace();}
  return s.stress.trace()*s.stress.trace()/(18*p.K())+Dev(s.stress).squaredNorm()/(4*p.G())+s.hardeningEnergy;
}
inline void SolidInitialize(const Parameters& p,State& s,bool planeStrain){
  if(p.law==5)s.temperature=p.solid[8];
  if(p.law==9){s.pc=p.solid[4];SolidRequire(s.initialPressure>0,"MCC requires positive initial effective confinement.");}
  if(p.law==10)s.pc=p.solid[3];
  if(p.law==7){s.memory.resize(4,Tensor::Zero());for(int i=0;i<4;i++)s.memory[i]=2*p.G()*p.solid[2*i]*Dev(s.strain);}
  if(p.law==12){
    if(!planeStrain){Tensor z=Tensor::Zero();z(2,2)=1;const Tensor iz=ElasticIncrement(p,z);s.strain(2,2)=0;s.strain(2,2)=-ElasticIncrement(p,s.strain)(2,2)/iz(2,2);}
    s.stress=s.effective=ElasticIncrement(p,s.strain);
  }
  if(Hyperelastic(p)||p.law==14)SolidRequire(s.strain.norm()<1e-12,"Hyperelastic/HJC initial preload requires nonlinear static initialization; choose sudden loading.");
  if(p.law==4||p.law==5||p.law==6||p.law==9||p.law==10||p.law==11){State test=s;SolidStep(p,test,Tensor::Zero(),1e-12,false);SolidRequire((test.stress-s.stress).norm()<=1e-6*std::max(1.,s.stress.norm()),"Initial equilibrium exceeds solid yield; nonlinear static initialization is required.");}
}
} }

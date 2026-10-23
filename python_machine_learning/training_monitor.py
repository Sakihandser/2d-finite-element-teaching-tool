"""Geometry-balanced label metrics and conservative training control."""
from collections import defaultdict
import math


def aggregate_metrics(rows):
    if not rows:
        return None
    cases=defaultdict(list)
    for group,sample,metrics in rows:
        cases[group,sample].append(metrics)
    fields=rows[0][2].keys()
    average=lambda items:{key:sum(row[key] for row in items)/len(items) for key in fields}
    groups=defaultdict(list)
    worst=[]
    for (group,sample),metrics in cases.items():
        result=average(metrics);groups[group].append(result)
        worst.append({'id':sample,'loss':result['loss'],'logBias':result['logBias']})
    result=average([average(items) for items in groups.values()])
    result.update(groups=len(groups),cases=len(cases),graphs=len(rows),
        worstCases=sorted(worst,key=lambda item:item['loss'],reverse=True)[:5])
    # Unlike averaging exp(error), this remains the factor corresponding to the
    # displayed geometry-macro log MAE.
    result['sizeFactor']=math.exp(min(result['logMae'],20))
    return result


def update_monitor(state, optimizer, scheduler, training, validation, integrity):
    config=state['config'];monitor=state.setdefault('monitor',{})
    trusted=validation is not None and integrity=='independent'
    metric=validation['loss'] if trusted else training['loss']
    rate=float(optimizer.param_groups[0]['lr'])
    adaptive=config.get('adaptiveTraining',False)
    if adaptive:
        scheduler.step(metric)
    current_rate=float(optimizer.param_groups[0]['lr'])
    if current_rate<rate:
        monitor['lrReductions']=monitor.get('lrReductions',0)+1
    if trusted:
        best=monitor.get('best')
        if best is None or metric < best-config.get('minDelta',.0001):
            monitor.update(best=metric,badEpochs=0,bestTrainLoss=training['loss'])
        else:
            monitor['badEpochs']=monitor.get('badEpochs',0)+1
    else:
        monitor['badEpochs']=0
    epoch_count=state['epoch']-state.get('phaseStartEpoch',0)
    diagnosis='learning'
    if validation is None:
        diagnosis='no-validation'
    elif integrity!='independent':
        diagnosis='validation-leakage'
    elif epoch_count<5:
        diagnosis='warming-up'
    elif metric>max(training['loss']*1.5,training['loss']+.02) and metric>monitor.get('best',metric)*1.1:
        diagnosis='overfitting-risk'
    elif training['baselineLoss']>1e-12 and training['loss']>=training['baselineLoss']*.95:
        diagnosis='baseline-not-beaten'
    elif monitor.get('badEpochs',0)>=config.get('lrPatience',8):
        diagnosis='plateau'
    if epoch_count>=5 and training.get('targetResidualStd',0)>.1 and training.get('residualStd',1)<1e-4:
        diagnosis='constant-size-collapse'
    action=None
    automatic=bool(adaptive and trusted and config.get('automaticRecovery',False))
    # Count persistent deterioration, not one noisy validation point. A gap
    # alone is insufficient: validation must regress from its own best while
    # training continues to improve.
    overfit=bool(trusted and metric>monitor.get('best',metric)*1.1 and
        metric>max(training['loss']*1.5,training['loss']+.02) and
        training['loss']<monitor.get('bestTrainLoss',training['loss'])*.98)
    monitor['overfitEpochs']=monitor.get('overfitEpochs',0)+1 if overfit else 0
    since=state['epoch']-monitor.get('lastRecoveryEpoch',state.get('phaseStartEpoch',0))
    persistent_overfit=monitor['overfitEpochs']>=config.get('recoveryPatience',3) and since>=config.get('recoveryPatience',3)
    stalled=monitor.get('badEpochs',0)>=config.get('lrPatience',8) and since>=config.get('lrPatience',8)
    if automatic and (persistent_overfit or stalled):
        attempts=monitor.get('recoveryAttempts',0)
        # Compare against the rate before this scheduler step so a simultaneous
        # reduction does not cause an accidental second factor-of-two decay.
        floor=config.get('minLearningRate',1e-6)
        next_rate=max(floor,rate*.5)
        possible=attempts<config.get('maxRecoveryAttempts',3) and next_rate<rate-1e-12
        action='recover-best' if possible else 'stop' if config.get('earlyStoppingPatience',25)>0 else None
    patience=config.get('earlyStoppingPatience',25)
    stop=bool(adaptive and trusted and patience>0 and epoch_count>=10 and
        monitor.get('badEpochs',0)>=patience and monitor.get('lrReductions',0)>0)
    if action=='stop':stop=True
    if stop:action='stop'
    state['diagnostics']={'code':diagnosis,'validationIntegrity':integrity,
        'smallValidation':bool(validation and validation['groups']<3),
        'trainingGroups':training['groups'],'validationGroups':validation['groups'] if validation else 0,
        'learningRate':current_rate,'lrReductions':monitor.get('lrReductions',0),
        'badEpochs':monitor.get('badEpochs',0),'earlyStoppingEnabled':bool(adaptive and trusted and patience>0),
        'action':action,'automaticRecovery':automatic,'recoveryAttempts':monitor.get('recoveryAttempts',0),
        'weightDecay':float(optimizer.param_groups[0].get('weight_decay',0)),
        'dropout':state.get('regularizationDropout',0.),
        'recoveryReason':'overfitting' if persistent_overfit else 'plateau',
        'nextLearningRate':max(config.get('minLearningRate',1e-6),rate*.5)}
    return stop,current_rate<rate

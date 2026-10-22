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
            monitor.update(best=metric,badEpochs=0)
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
    patience=config.get('earlyStoppingPatience',25)
    stop=bool(adaptive and trusted and patience>0 and epoch_count>=10 and
        monitor.get('badEpochs',0)>=patience and monitor.get('lrReductions',0)>0)
    state['diagnostics']={'code':diagnosis,'validationIntegrity':integrity,
        'smallValidation':bool(validation and validation['groups']<3),
        'trainingGroups':training['groups'],'validationGroups':validation['groups'] if validation else 0,
        'learningRate':current_rate,'lrReductions':monitor.get('lrReductions',0),
        'badEpochs':monitor.get('badEpochs',0),'earlyStoppingEnabled':bool(adaptive and trusted and patience>0)}
    return stop,current_rate<rate

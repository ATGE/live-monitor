import React from 'react';
import Icon from '../Icon.jsx';
import CardSection from './CardSection.jsx';
import { serviceUrl } from '../../serviceUrl.js';
import { useStrings } from '../../i18n/useStrings.js';
import { fill, splitAround } from '../../i18n/index.js';

/** Where else the task keeps a worktree, one line per machine. */
export function PlacesList({ task, m, h }) {
  const t = useStrings();
  const { placesLocked, parked } = m;
  const { onDeletePlace } = h;
  if (!parked.length) return null;
  return (
    <>
      {parked.map((p) => (
        <div key={p.machine} className="tce-place">
          <Icon name="folder-git" />
          <span className="tce-place-text">
            {splitAround(t.card.env.parked, { machine: p.machine }).map((part) => (part.hole
              ? <b key={part.key}>{part.text}</b> : <React.Fragment key={part.key}>{part.text}</React.Fragment>))}
          </span>
          <button type="button" className="btn btn-icon btn-danger tce-place-delete" disabled={placesLocked}
            onClick={() => onDeletePlace(task.issue, p.machine)}
            title={fill(t.card.env.deletePlaceTitle, { machine: p.machine })}
            aria-label={fill(t.card.env.deletePlaceAria, { machine: p.machine })}><Icon name="trash" /></button>
        </div>
      ))}
    </>
  );
}

export default function EnvGroup({ task, m, h, compact = false, variant = 'expanded' }) {
  const t = useStrings();
  const { busy, machine, canPickMachine, stack, services, branch, canMove, goBack, parked } = m;
  const { onCreateWorktree, onStartStack, onStopStack, machines, onSetMachine, onMove } = h;

  const canCreate = !task.hasWorktree && !busy;
  const canStartApp = task.hasWorktree && !stack && task.hasStack !== false;
  const hasPlaces = parked.length > 0;
  const hasButtons = canPickMachine || canMove || Boolean(goBack) || canCreate || canStartApp;
  if (!hasButtons && !stack && !hasPlaces) return null;

  return (
    <CardSection title={t.card.env.title} note={<><Icon name="map-pin" /> {machine}</>}>
      {hasButtons && (
        <div className="tce-actions">
          {canPickMachine && (
            <label className="tce-machine" title={t.card.env.machineTitle}>
              <Icon name="map-pin" />
              <select aria-label={t.card.env.machineAria} value={machine} onChange={(e) => onSetMachine(task.issue, e.target.value)}>
                {machines.map((mc) => (
                  <option key={mc.name} value={mc.name}>{mc.kind === 'local' ? t.card.env.here : mc.name}</option>
                ))}
              </select>
            </label>
          )}
          {canMove && (
            <button type="button" className="btn btn-sm" onClick={() => onMove(task.issue, null)}
              title={fill(t.card.env.moveTitle, { machine })}>
              <Icon name="map-pin" /> {t.card.env.move}
            </button>
          )}
          {goBack && (
            <button type="button" className="btn btn-sm" onClick={() => onMove(task.issue, goBack)}
              title={fill(t.card.env.goBackTitle, { machine: goBack })}>
              <Icon name="undo" /> {fill(t.card.env.goBack, { machine: goBack })}
            </button>
          )}
          {canCreate && (
            <button type="button" className="btn btn-sm" onClick={() => onCreateWorktree(task.issue)}
              title={fill(branch
                ? (machine !== 'local' ? t.card.env.createAdoptOn : t.card.env.createAdopt)
                : (machine !== 'local' ? t.card.env.createOn : t.card.env.create), { branch, machine })}>
              <Icon name="tree" /> {t.card.env.createWorktree}
            </button>
          )}
          {canStartApp && (
            <button type="button" className="btn btn-sm" onClick={() => onStartStack(task.issue)}
              title={t.card.env.startAppTitle}>
              <Icon name="play" /> {t.card.env.startApp}
            </button>
          )}
        </div>
      )}
      {stack && (
        <div className={`tce-stack tce-stack-${stack.status}`}>
          <div className="tce-stack-row">
            <span className="tce-stack-status">
              {stack.status === 'starting' && <><Icon name="hourglass" /> <span>{t.card.env.stackStarting}</span></>}
              {stack.status === 'stopping' && <><Icon name="hourglass" /> <span>{t.card.env.stackStopping}</span></>}
              {stack.status === 'running' && <><span className="tce-dot tce-dot-ok" aria-hidden="true" /> <span>{t.card.env.stackRunning}</span></>}
              {stack.status === 'error' && <><span className="tce-dot tce-dot-error" aria-hidden="true" /> <span>{stack.error ?? t.card.env.stackError}</span></>}
            </span>
            {stack.status !== 'starting' && stack.status !== 'stopping' && (
              <button type="button" className="btn btn-xs tce-stop" onClick={() => onStopStack(task.issue)}
                title={t.card.env.stopTitle}>
                <Icon name="stop" /> {t.card.env.stop}
              </button>
            )}
          </div>
          {services.length > 0 && (
            <div className="tce-links">
              {services.map((s) => (
                <a key={s.label} className={`tce-link ${s.healthy ? 'is-up' : 'is-pending'}`}
                  href={serviceUrl(s)} target="_blank" rel="noreferrer"
                  title={fill(s.healthy ? t.card.env.linkUp : t.card.env.linkPending, { label: s.label, url: serviceUrl(s) })}>
                  <Icon name={s.healthy ? 'link' : 'hourglass'} />
                  <span>{s.label} :{s.port}</span>
                  <Icon name="external" />
                </a>
              ))}
            </div>
          )}
          {/* No "desde HH:MM": the stack record (server/src/stack.js) carries no start time. */}
        </div>
      )}
      {hasPlaces && <PlacesList task={task} m={m} h={h} />}
    </CardSection>
  );
}

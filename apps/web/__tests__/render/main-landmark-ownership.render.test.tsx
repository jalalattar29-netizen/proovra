import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MainLandmarkContext } from '../../components/navigation/MainLandmarkContext';
import { ProovraSystemState } from '../../components/feedback/ProovraSystemState';
import { OperationalBreadcrumb } from '../../components/navigation/OperationalBreadcrumb';
vi.mock('../../lib/platform-context', () => ({ usePlatformContext: () => ({ state: { name: 'READY', envelope: { workspace: { name: 'Example workspace' } } } }) }));
afterEach(cleanup);
describe('main landmark ownership',()=>{
 for(const kind of ['not-found','forbidden','unavailable','server-error'] as const){
  it(`keeps exactly one main for an in-shell ${kind} state`,()=>{
   render(<MainLandmarkContext.Provider value={true}><main id="app-main-content"><ProovraSystemState kind={kind} context="authenticated" /></main></MainLandmarkContext.Provider>);
   expect(screen.getAllByRole('main')).toHaveLength(1);
   expect(screen.getByRole('main').id).toBe('app-main-content');
   expect(within(screen.getByRole('main')).getByRole('heading',{level:1})).toBeTruthy();
  });
 }
 it('keeps a main for a standalone authenticated routing 404',()=>{
  render(<ProovraSystemState kind="not-found" context="authenticated" />);
  expect(screen.getAllByRole('main')).toHaveLength(1);
 });
 it('keeps contained states out of the landmark list',()=>{
  render(<ProovraSystemState kind="unavailable" context="authenticated" presentation="contained" />);
  expect(screen.queryByRole('main')).toBeNull();
 });
});
it('announces the current retention breadcrumb and links to Governance once',()=>{
 render(<OperationalBreadcrumb routeId="governance.retention" items={[{label:'Retention policies'}]} />);
 const nav=screen.getByRole('navigation',{name:'Operational breadcrumb'});
 expect(within(nav).getAllByRole('link',{name:'Governance'})).toHaveLength(1);
 expect(within(nav).getByText('Retention policies').getAttribute('aria-current')).toBe('page');
});

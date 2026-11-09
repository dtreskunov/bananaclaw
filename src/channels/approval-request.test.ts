import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeOptions, resolveApprovalAction, USER_APPROVAL_OPTIONS } from './approval-request.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';
import { createApproval } from '../db/approvals.js';
import { getApprovalRender } from '../db/sessions.js';

describe('approval request options', () => {
  it('preserves labels and values while defaulting omitted fields', () => {
    expect(
      normalizeOptions([
        'Yes',
        { label: 'Approve', value: 'approve' },
        { label: 'Reject', selectedLabel: 'Rejected', value: 'reject' },
      ]),
    ).toEqual([
      { label: 'Yes', selectedLabel: 'Yes', value: 'Yes' },
      { label: 'Approve', selectedLabel: 'Approve', value: 'approve' },
      { label: 'Reject', selectedLabel: 'Rejected', value: 'reject' },
    ]);
  });

  const lookup = (id: string) =>
    id === 'approval'
      ? { title: 'Approval', options: normalizeOptions([{ label: 'Connect', value: 'connect:agent' }]) }
      : undefined;

  it('resolves the canonical index to the persisted option value', () => {
    expect(resolveApprovalAction('nca:approval:0', lookup)).toEqual({
      approvalId: 'approval',
      title: 'Approval',
      option: { label: 'Connect', selectedLabel: 'Connect', value: 'connect:agent' },
    });
  });

  it.each([
    'ncq:approval:0',
    'nca:approval:approve',
    'nca:approval:0:approve',
    'nca:approval:00',
    'nca:approval:-1',
    'nca:approval:1',
    'nca:approval:9007199254740992',
    'nca:missing:0',
  ])('rejects unsupported or out-of-range callback %s', (value) => {
    expect(resolveApprovalAction(value, lookup)).toBeUndefined();
  });
});

describe('approval render lookup', () => {
  beforeEach(() => runMigrations(initTestDb()));
  afterEach(closeDb);

  it('reads approval records and ignores missing IDs', () => {
    createApproval({
      id: 'approval',
      request_id: 'approval',
      created_at: Date.now(),
      input: { action: 'test', payload: {}, title: 'Review', options: USER_APPROVAL_OPTIONS },
    });
    expect(getApprovalRender('approval')).toEqual({ title: 'Review', options: USER_APPROVAL_OPTIONS });
    expect(getApprovalRender('missing')).toBeUndefined();
  });

  it('resolves user onboarding options using the same schema as their producer', () => {
    getDb()
      .prepare(
        "INSERT INTO pending_user_approvals(id,provider,sub,status) VALUES('pua-user','google','subject','pending')",
      )
      .run();
    expect(getApprovalRender('pua-user')).toEqual({
      title: '👤 New user wants access',
      options: USER_APPROVAL_OPTIONS,
    });
  });
});

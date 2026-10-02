export const BRANCH_ACTION_EXPLANATION =
  'Start a new thread that continues from this message.\n\n' +
  'The conversation up to here is copied into the branch. Anything after it stays behind, ' +
  'and this thread is left untouched.\n\n' +
  'Workspace files and the agent\u2019s memory are shared, not copied \u2014 work done in one ' +
  'branch is visible from the other. Scheduled tasks stay with this thread.';

export function editBranchActionExplanation(hasAnchor: boolean): string {
  return hasAnchor
    ? 'Start a new branch immediately before this message and copy its text into the composer ' +
        'for editing.\n\nNothing is sent until you review and send the edited text. The original ' +
        'thread and message stay unchanged. Workspace files and the agent\u2019s memory remain shared.'
    : 'This is the first conversational message, so there is no earlier point to branch from. ' +
        'A new blank web thread will open with this message copied into the composer.\n\nNothing ' +
        'is sent until you review and send the edited text. The original thread and message stay unchanged.';
}

export type QuestionResponse = { responseType?: 'answer'; value: string } | { responseType: 'skipped'; value?: never };

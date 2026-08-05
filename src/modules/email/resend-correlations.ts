import { getDb } from '../../db/connection.js';

export interface ResendOutboundCorrelation {
  correlation_token: string;
  origin_session_id: string;
  email_thread_id: string;
  created_at: string;
}

export function createResendOutboundCorrelation(
  row: Pick<ResendOutboundCorrelation, 'correlation_token' | 'origin_session_id' | 'email_thread_id' | 'created_at'>,
): void {
  getDb()
    .prepare(
      `INSERT INTO resend_outbound_correlations
         (correlation_token, origin_session_id, email_thread_id, created_at)
       VALUES (@correlation_token, @origin_session_id, @email_thread_id, @created_at)`,
    )
    .run(row);
}

export function getResendOutboundCorrelationByToken(token: string): ResendOutboundCorrelation | undefined {
  return getDb().prepare('SELECT * FROM resend_outbound_correlations WHERE correlation_token = ?').get(token) as
    | ResendOutboundCorrelation
    | undefined;
}

export function deleteResendOutboundCorrelation(token: string): void {
  getDb().prepare('DELETE FROM resend_outbound_correlations WHERE correlation_token = ?').run(token);
}

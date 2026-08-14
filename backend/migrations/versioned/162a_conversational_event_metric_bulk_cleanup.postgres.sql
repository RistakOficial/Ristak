CREATE OR REPLACE FUNCTION ristak_conversational_agent_metrics_reproject()
RETURNS TRIGGER AS $$
DECLARE
  row_id TEXT := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
BEGIN
  -- El saneamiento histórico ya descuenta el resumen y elimina el ledger en
  -- bloque. Saltar sólo esta reproyección de DELETE, en la misma sesión y
  -- transacción, evita millones de búsquedas redundantes. Las demás conexiones
  -- siguen proyectando sus métricas normalmente.
  IF TG_TABLE_NAME = 'conversational_agent_events'
     AND TG_OP = 'DELETE'
     AND current_setting(
       'ristak.skip_conversational_event_metrics_reproject',
       true
     ) = 'on' THEN
    RETURN OLD;
  END IF;

  IF TG_TABLE_NAME = 'conversational_agent_state' THEN
    DELETE FROM conversational_agent_state_metric_rows WHERE state_id = row_id;
    IF TG_OP != 'DELETE' THEN
      INSERT INTO conversational_agent_state_metric_rows (
        state_id, projection_version, included, agent_id, total_conversations,
        assigned_conversations, completed_conversations, paused_conversations,
        human_takeovers, skipped_conversations, discarded_conversations,
        answered_conversations, activity_at, updated_at
      )
      SELECT state_id, projection_version, included, agent_id, total_conversations,
             assigned_conversations, completed_conversations, paused_conversations,
             human_takeovers, skipped_conversations, discarded_conversations,
             answered_conversations, activity_at, CURRENT_TIMESTAMP
      FROM ristak_conversational_state_metric_source
      WHERE state_id = row_id;
    END IF;
  ELSE
    DELETE FROM conversational_agent_event_metric_rows WHERE event_id = row_id;
    IF TG_OP != 'DELETE' THEN
      INSERT INTO conversational_agent_event_metric_rows (
        event_id, projection_version, included, summary_shard, total_events,
        success_events, error_events, assigned_events, reply_events,
        appointment_events, payment_link_events, goal_completion_events,
        follow_up_sent_events, follow_up_suppressed_events, human_handoff_events,
        tool_failure_events, updated_at
      )
      SELECT event_id, projection_version, included, summary_shard, total_events,
             success_events, error_events, assigned_events, reply_events,
             appointment_events, payment_link_events, goal_completion_events,
             follow_up_sent_events, follow_up_suppressed_events, human_handoff_events,
             tool_failure_events, CURRENT_TIMESTAMP
      FROM ristak_conversational_event_metric_source
      WHERE event_id = row_id;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

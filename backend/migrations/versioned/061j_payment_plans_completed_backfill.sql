UPDATE payment_plans
SET status = 'completed'
WHERE LOWER(COALESCE(status, 'active')) IN ('active', 'scheduled', 'pending', 'sent')
  AND EXISTS (
    SELECT 1
    FROM payment_flows
    WHERE payment_flows.id = payment_plans.id
      AND (
        COALESCE(payment_flows.first_payment_amount, 0) > 0
        OR EXISTS (
          SELECT 1
          FROM installment_payments
          WHERE installment_payments.flow_id = payment_flows.id
            AND LOWER(COALESCE(installment_payments.status, 'pending')) NOT IN ('cancelled', 'canceled', 'deleted', 'void')
        )
      )
      AND (
        COALESCE(payment_flows.first_payment_amount, 0) <= 0
        OR LOWER(COALESCE(payment_flows.first_payment_status, 'pending')) IN (
          'paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'registered'
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM installment_payments
        WHERE installment_payments.flow_id = payment_flows.id
          AND LOWER(COALESCE(installment_payments.status, 'pending')) NOT IN ('cancelled', 'canceled', 'deleted', 'void')
          AND LOWER(COALESCE(installment_payments.status, 'pending')) NOT IN (
            'paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'registered'
          )
      )
  );

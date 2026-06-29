import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createPublicPaymentId,
  createRistakId,
  createRistakPaymentEntityId
} from '../src/utils/idGenerator.js'

const SHORT_TAIL = '[A-Za-z0-9]{20}'

describe('Ristak ID generator', () => {
  it('keeps rstk nomenclature with short alphanumeric tails', () => {
    assert.match(createRistakId('contact'), new RegExp(`^rstk_contact_${SHORT_TAIL}$`))
    assert.match(createRistakId('prod'), new RegExp(`^rstk_prod_${SHORT_TAIL}$`))
    assert.match(createRistakId('price'), new RegExp(`^rstk_price_${SHORT_TAIL}$`))
    assert.match(createRistakId('cal'), new RegExp(`^rstk_cal_${SHORT_TAIL}$`))
    assert.match(createPublicPaymentId(), new RegExp(`^rstk_pay_${SHORT_TAIL}$`))
  })

  it('normalizes payment entity ids by role instead of leaking provider prefixes', () => {
    assert.match(createRistakPaymentEntityId('stripe_payment'), new RegExp(`^rstk_payment_${SHORT_TAIL}$`))
    assert.match(createRistakPaymentEntityId('conekta_flow'), new RegExp(`^rstk_payment_flow_${SHORT_TAIL}$`))
    assert.match(createRistakPaymentEntityId('mp_installment'), new RegExp(`^rstk_installment_${SHORT_TAIL}$`))
    assert.match(createRistakPaymentEntityId('stripe_pm'), new RegExp(`^rstk_payment_method_${SHORT_TAIL}$`))
    assert.match(createRistakPaymentEntityId('conekta_source'), new RegExp(`^rstk_payment_source_${SHORT_TAIL}$`))
  })
})

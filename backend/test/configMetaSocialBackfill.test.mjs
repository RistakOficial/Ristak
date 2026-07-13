import test from 'node:test'
import assert from 'node:assert/strict'
import { getNewlyEnabledMetaSocialPlatforms } from '../src/controllers/configController.js'

test('Meta social inicia historial solo cuando mensajeria cambia de apagada a encendida', () => {
  assert.deepEqual(
    getNewlyEnabledMetaSocialPlatforms(
      {
        meta_messenger_messaging_enabled: true,
        meta_instagram_messaging_enabled: '1'
      },
      {
        meta_messenger_messaging_enabled: '1',
        meta_instagram_messaging_enabled: 'false'
      }
    ),
    ['instagram']
  )
})

test('Meta social no repite historial por guardar otra vez los mismos switches', () => {
  assert.deepEqual(
    getNewlyEnabledMetaSocialPlatforms(
      {
        meta_messenger_messaging_enabled: 'true',
        meta_instagram_messaging_enabled: true,
        meta_facebook_comments_enabled: true
      },
      {
        meta_messenger_messaging_enabled: '1',
        meta_instagram_messaging_enabled: 'true',
        meta_facebook_comments_enabled: 'false'
      }
    ),
    []
  )
})

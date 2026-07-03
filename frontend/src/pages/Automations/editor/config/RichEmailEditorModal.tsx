import React, { useEffect, useState } from 'react'
import { Mail, Save } from 'lucide-react'
import {
  Button,
  EmailRichTextEditor,
  Modal,
  Switch,
  emailHtmlToPlainText,
  plainTextToEmailHtml,
  sanitizeEmailRichHtmlForEditor,
  type EmailRichTextVariable
} from '@/components/common'
import { VariableTextInput } from '../composer/MessageComposer'
import styles from '../AutomationEditor.module.css'

interface RichEmailEditorModalProps {
  open: boolean
  subject: string
  body: string
  bodyHtml: string
  includeSignature: boolean
  variables: EmailRichTextVariable[]
  onClose: () => void
  onSave: (nextConfig: { subject: string; body: string; bodyHtml: string; includeSignature: boolean }) => void
}

export const RichEmailEditorModal: React.FC<RichEmailEditorModalProps> = ({
  open,
  subject,
  body,
  bodyHtml,
  includeSignature,
  variables,
  onClose,
  onSave
}) => {
  const [draftSubject, setDraftSubject] = useState(subject)
  const [draftHtml, setDraftHtml] = useState(bodyHtml || plainTextToEmailHtml(body))
  const [draftIncludeSignature, setDraftIncludeSignature] = useState(includeSignature)

  useEffect(() => {
    if (!open) return
    setDraftSubject(subject)
    setDraftHtml(bodyHtml || plainTextToEmailHtml(body))
    setDraftIncludeSignature(includeSignature)
  }, [body, bodyHtml, includeSignature, open, subject])

  const save = () => {
    const cleanHtml = sanitizeEmailRichHtmlForEditor(draftHtml)
    onSave({
      subject: draftSubject,
      body: emailHtmlToPlainText(cleanHtml),
      bodyHtml: cleanHtml,
      includeSignature: draftIncludeSignature
    })
    onClose()
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Editar correo"
      size="xl"
      contentClassName={styles.emailModalContent}
    >
      <div className={styles.emailModalBody} data-automation-interactive="true">
        <div className={styles.emailModalHeader}>
          <span className={styles.emailModalIcon}>
            <Mail size={18} />
          </span>
          <div>
            <strong>Contenido del correo</strong>
            <p>Este editor es solo para correos: puedes dar formato, pegar HTML, subir imágenes y usar variables.</p>
          </div>
        </div>

        <label className={styles.emailModalField}>
          <span>Asunto</span>
          <VariableTextInput
            value={draftSubject}
            onChange={setDraftSubject}
            placeholder="Asunto del correo"
            aria-label="Asunto del correo"
          />
        </label>

        <EmailRichTextEditor
          value={draftHtml}
          onChange={setDraftHtml}
          density="modal"
          variables={variables}
          placeholder="Escribe el correo..."
          codePlaceholder="<table><tr><td>Contenido del correo...</td></tr></table>"
        />

        <label className={styles.emailSignatureToggle}>
          <Switch
            checked={draftIncludeSignature}
            onChange={setDraftIncludeSignature}
            aria-label="Agregar firma guardada al enviar"
          />
          <span>Agregar la firma guardada al enviar</span>
        </label>

        <div className={styles.emailModalActions}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="button" onClick={save}>
            <Save size={16} />
            Guardar correo
          </Button>
        </div>
      </div>
    </Modal>
  )
}

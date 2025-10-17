import React, { useState } from 'react'
import { Card, Button } from '@/components/common'
import { CheckCircle, ExternalLink, ChevronDown, ChevronUp, AlertCircle, Info, Facebook } from 'lucide-react'
import styles from './HighLevelIntegration.module.css'

export const MetaAdsIntegration: React.FC = () => {
  const [openSection, setOpenSection] = useState<number | null>(null)

  const toggleSection = (section: number) => {
    setOpenSection(openSection === section ? null : section)
  }

  return (
    <div className={styles.integrationContainer}>
      <Card className={styles.mainCard}>
        {/* Header */}
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerLeft}>
              <div className={styles.logoContainer}>
                <div className={styles.iconWrapper} style={{
                  backgroundColor: '#0866FF',
                  borderRadius: '12px',
                  width: '60px',
                  height: '60px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}>
                  <Facebook size={36} color="white" />
                </div>
              </div>
              <h2 className={styles.pageTitle}>Meta Ads</h2>
              <p className={styles.pageSubtitle}>
                Tutorial completo para conectar tus anuncios de Facebook con Ristak
              </p>
            </div>
          </div>
        </div>

        {/* Introducción */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>¿Para qué sirve esta integración?</h3>
          </div>
          <div className={styles.sectionContent}>
            <p className={styles.infoText}>
              Esta integración trae automáticamente las métricas de tus anuncios de Facebook (gasto, clics, alcance, etc.)
              para que puedas ver el rendimiento de tus campañas directamente en Ristak sin tener que entrar a Meta Business Manager.
            </p>
          </div>
        </div>

        {/* Lo que necesitas */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Lo que vas a necesitar</h3>
          </div>
          <div className={styles.sectionContent}>
            <div className={styles.checklistGrid}>
              <div className={styles.checklistItem}>
                <CheckCircle size={18} className={styles.checklistIcon} />
                <span>Una cuenta de Meta Business Manager</span>
              </div>
              <div className={styles.checklistItem}>
                <CheckCircle size={18} className={styles.checklistIcon} />
                <span>Una cuenta de anuncios de Facebook activa</span>
              </div>
              <div className={styles.checklistItem}>
                <CheckCircle size={18} className={styles.checklistIcon} />
                <span>10-15 minutos para seguir los pasos</span>
              </div>
              <div className={styles.checklistItem}>
                <CheckCircle size={18} className={styles.checklistIcon} />
                <span>Acceso a Meta Developers (gratis)</span>
              </div>
            </div>
          </div>
        </div>

        {/* Scopes Requeridos */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Permisos (Scopes) que necesitarás</h3>
          </div>
          <div className={styles.sectionContent}>
            <p className={styles.infoText}>
              Cuando generes el Access Token en el Paso 2, necesitarás seleccionar estos permisos:
            </p>
            <div className={styles.checklistGrid}>
              <div className={styles.checklistItem}>
                <CheckCircle size={18} className={styles.checklistIcon} />
                <span><code>ads_read</code> - Para leer datos de anuncios</span>
              </div>
              <div className={styles.checklistItem}>
                <CheckCircle size={18} className={styles.checklistIcon} />
                <span><code>ads_management</code> - Opcional, si quieres crear/editar campañas</span>
              </div>
              <div className={styles.checklistItem}>
                <CheckCircle size={18} className={styles.checklistIcon} />
                <span><code>business_management</code> - Para acceder a cuentas de anuncios</span>
              </div>
            </div>
          </div>
        </div>

        {/* Tutorial paso a paso */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Tutorial Paso a Paso</h3>
          </div>
          <div className={styles.sectionContent}>
            {/* Paso 1 */}
            <div className={styles.tutorialStep}>
              <div
                className={styles.stepHeader}
                onClick={() => toggleSection(1)}
              >
                <div className={styles.stepNumber}>1</div>
                <div className={styles.stepInfo}>
                  <h4 className={styles.stepTitle}>Crear una App en Meta Developers</h4>
                  <p className={styles.stepSubtitle}>Necesitas una App para conectarte a la API de Meta</p>
                </div>
                {openSection === 1 ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
              </div>

              {openSection === 1 && (
                <div className={styles.stepContent}>
                  <ol className={styles.stepList}>
                    <li>
                      <strong>Ve a Meta Developers:</strong>
                      <br />
                      <a
                        href="https://developers.facebook.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.externalLink}
                      >
                        https://developers.facebook.com <ExternalLink size={14} />
                      </a>
                      <br />
                      <span className={styles.hint}>Inicia sesión con tu cuenta de Facebook</span>
                    </li>
                    <li>
                      <strong>Crea una nueva App:</strong>
                      <ul>
                        <li>Haz clic en el botón verde "Crear App" (arriba a la derecha)</li>
                        <li>Selecciona tipo: <strong>"Empresa"</strong> o <strong>"Business"</strong></li>
                        <li>Dale un nombre a tu App (ejemplo: "Ristak API" o "Mi Negocio Ads")</li>
                        <li>Correo de contacto: Pon tu email</li>
                        <li>Business Account: Selecciona tu cuenta de negocio (si tienes)</li>
                        <li>Haz clic en "Crear App"</li>
                      </ul>
                    </li>
                    <li>
                      <strong>Agrega el producto "Marketing API":</strong>
                      <ul>
                        <li>En el dashboard de tu App, verás una lista de productos</li>
                        <li>Busca <strong>"Marketing API"</strong></li>
                        <li>Haz clic en "Configurar" o "Set Up"</li>
                        <li>Acepta los términos si te los pide</li>
                      </ul>
                    </li>
                    <li>
                      <strong>Obtén tu App ID y App Secret:</strong>
                      <ul>
                        <li>Ve a <strong>"Configuración" → "Básica"</strong> (en el menú lateral)</li>
                        <li>Copia el <strong>"App ID"</strong> (un número largo tipo: 1234567890123456)</li>
                        <li>Copia el <strong>"App Secret"</strong> (haz clic en "Mostrar" y cópialo)</li>
                        <li className={styles.warningText}>⚠️ GUARDA ESTOS VALORES - Los necesitarás en el Paso 4</li>
                      </ul>
                    </li>
                  </ol>

                  <div className={styles.infoBox}>
                    <Info size={18} />
                    <div>
                      <strong>Tip:</strong> No te preocupes si ves advertencias de "App no revisada" o similar.
                      Para uso interno no necesitas enviar la App a revisión de Meta.
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Paso 2 */}
            <div className={styles.tutorialStep}>
              <div
                className={styles.stepHeader}
                onClick={() => toggleSection(2)}
              >
                <div className={styles.stepNumber}>2</div>
                <div className={styles.stepInfo}>
                  <h4 className={styles.stepTitle}>Obtener un Token de Acceso Permanente (System User)</h4>
                  <p className={styles.stepSubtitle}>Este token NUNCA caduca - es la mejor opción</p>
                </div>
                {openSection === 2 ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
              </div>

              {openSection === 2 && (
                <div className={styles.stepContent}>
                  <ol className={styles.stepList}>
                    <li>
                      <strong>Ve a Meta Business Manager:</strong>
                      <br />
                      <a
                        href="https://business.facebook.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.externalLink}
                      >
                        https://business.facebook.com <ExternalLink size={14} />
                      </a>
                    </li>
                    <li>
                      <strong>Crea un System User:</strong>
                      <ul>
                        <li>En el menú de hamburguesa (☰), selecciona tu cuenta de negocio</li>
                        <li>Ve a <strong>"Configuración de la empresa"</strong> o <strong>"Business Settings"</strong></li>
                        <li>En el menú lateral, busca <strong>"Usuarios" → "Usuarios del sistema"</strong> (System Users)</li>
                        <li>Haz clic en <strong>"Agregar"</strong> o <strong>"Add"</strong></li>
                        <li>Ponle un nombre descriptivo (ejemplo: "Ristak API User")</li>
                        <li>Rol: Selecciona <strong>"Administrador"</strong> (Admin)</li>
                        <li>Haz clic en "Crear System User"</li>
                      </ul>
                    </li>
                    <li>
                      <strong>Genera el Access Token:</strong>
                      <ul>
                        <li>Haz clic en el System User que acabas de crear</li>
                        <li>Haz clic en <strong>"Generar nuevo token"</strong> o <strong>"Generate New Token"</strong></li>
                        <li>En "App", selecciona la App que creaste en el Paso 1</li>
                        <li>Selecciona los permisos que se mencionan arriba (<code>ads_read</code>, <code>ads_management</code>, <code>business_management</code>)</li>
                        <li>Duración: <strong>60 días o "Never expire"</strong></li>
                        <li>Haz clic en "Generar Token"</li>
                        <li className={styles.warningText}>
                          ⚠️ MUY IMPORTANTE: COPIA EL TOKEN AHORA - No lo volverás a ver
                        </li>
                      </ul>
                    </li>
                    <li>
                      <strong>Asigna el System User a tu cuenta de anuncios:</strong>
                      <ul>
                        <li>En Business Settings, ve a <strong>"Cuentas" → "Cuentas de anuncios"</strong></li>
                        <li>Selecciona tu cuenta de anuncios</li>
                        <li>Haz clic en <strong>"Agregar personas"</strong> o <strong>"Add People"</strong></li>
                        <li>Busca tu System User que creaste</li>
                        <li>Asígnale permisos de <strong>"Administrador de anuncios"</strong> (Ads Manager Admin)</li>
                        <li>Guarda los cambios</li>
                      </ul>
                    </li>
                  </ol>

                  <div className={styles.successBox}>
                    <CheckCircle size={18} />
                    <div>
                      <strong>Ventaja del System User:</strong> Este token NO caduca nunca (a menos que lo revokes manualmente).
                      Es la forma más profesional y segura de conectar integraciones.
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Paso 3 */}
            <div className={styles.tutorialStep}>
              <div
                className={styles.stepHeader}
                onClick={() => toggleSection(3)}
              >
                <div className={styles.stepNumber}>3</div>
                <div className={styles.stepInfo}>
                  <h4 className={styles.stepTitle}>Encontrar tu Ad Account ID</h4>
                  <p className={styles.stepSubtitle}>El ID único de tu cuenta de anuncios</p>
                </div>
                {openSection === 3 ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
              </div>

              {openSection === 3 && (
                <div className={styles.stepContent}>
                  <ol className={styles.stepList}>
                    <li>
                      <strong>Ve al Administrador de Anuncios:</strong>
                      <br />
                      <a
                        href="https://business.facebook.com/adsmanager"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.externalLink}
                      >
                        https://business.facebook.com/adsmanager <ExternalLink size={14} />
                      </a>
                    </li>
                    <li>
                      <strong>Encuentra tu Ad Account ID:</strong>
                      <ul>
                        <li>En la esquina superior izquierda, verás el nombre de tu cuenta de anuncios</li>
                        <li>Haz clic en el dropdown (flecha hacia abajo)</li>
                        <li>Verás algo como: <strong>"Mi Cuenta (ID: 123456789012345)"</strong></li>
                        <li>Copia SOLO el número (sin el prefijo "act_")</li>
                        <li>Ejemplo: Si dice <code>act_123456789012345</code>, solo copia <code>123456789012345</code></li>
                      </ul>
                    </li>
                  </ol>

                  <div className={styles.infoBox}>
                    <Info size={18} />
                    <div>
                      <strong>Alternativa:</strong> También puedes encontrarlo en Business Settings → Cuentas → Cuentas de anuncios.
                      Aparecerá como "ID de la cuenta de anuncios".
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Paso 4 */}
            <div className={styles.tutorialStep}>
              <div
                className={styles.stepHeader}
                onClick={() => toggleSection(4)}
              >
                <div className={styles.stepNumber}>4</div>
                <div className={styles.stepInfo}>
                  <h4 className={styles.stepTitle}>Guardar los valores en HighLevel Custom Values</h4>
                  <p className={styles.stepSubtitle}>Aquí es donde Ristak buscará tu configuración</p>
                </div>
                {openSection === 4 ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
              </div>

              {openSection === 4 && (
                <div className={styles.stepContent}>
                  <ol className={styles.stepList}>
                    <li>
                      <strong>Ve a tu cuenta de HighLevel:</strong>
                      <br />
                      <a
                        href="https://app.gohighlevel.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.externalLink}
                      >
                        https://app.gohighlevel.com <ExternalLink size={14} />
                      </a>
                    </li>
                    <li>
                      <strong>Accede a Custom Values:</strong>
                      <ul>
                        <li>En el menú lateral, ve a <strong>"Configuración" → "Custom Values"</strong></li>
                        <li>O busca "Custom Values" en la barra de búsqueda</li>
                      </ul>
                    </li>
                    <li>
                      <strong>Crea los siguientes Custom Values (exactamente con estos nombres):</strong>
                      <div className={styles.customValuesTable}>
                        <div className={styles.tableRow}>
                          <div className={styles.tableLabel}>Nombre del Custom Value</div>
                          <div className={styles.tableLabel}>Valor que debes pegar</div>
                        </div>
                        <div className={styles.tableRow}>
                          <div className={styles.tableCell}><code>Facebook - Ad Account ID</code></div>
                          <div className={styles.tableCell}>
                            El número de tu cuenta de anuncios (Paso 3)
                            <br />
                            <span className={styles.hint}>Ejemplo: 123456789012345</span>
                          </div>
                        </div>
                        <div className={styles.tableRow}>
                          <div className={styles.tableCell}><code>Facebook - App Access Token</code></div>
                          <div className={styles.tableCell}>
                            El token del System User (Paso 2)
                            <br />
                            <span className={styles.hint}>Ejemplo: EAAabcdef...</span>
                          </div>
                        </div>
                        <div className={styles.tableRow}>
                          <div className={styles.tableCell}><code>Facebook - App ID</code></div>
                          <div className={styles.tableCell}>
                            El App ID de Meta Developers (Paso 1)
                            <br />
                            <span className={styles.hint}>Ejemplo: 1234567890123456</span>
                          </div>
                        </div>
                        <div className={styles.tableRow}>
                          <div className={styles.tableCell}><code>Facebook - App Secret</code></div>
                          <div className={styles.tableCell}>
                            El App Secret de Meta Developers (Paso 1)
                            <br />
                            <span className={styles.hint}>Ejemplo: abc123def456...</span>
                          </div>
                        </div>
                      </div>
                    </li>
                    <li className={styles.warningText}>
                      <strong>⚠️ MUY IMPORTANTE:</strong> Los nombres de los Custom Values deben ser EXACTAMENTE como están arriba,
                      incluyendo mayúsculas, espacios y guiones. Si hay un error de tipeo, Ristak no encontrará la configuración.
                    </li>
                  </ol>

                  <div className={styles.infoBox}>
                    <Info size={18} />
                    <div>
                      <strong>Tip:</strong> Para crear un Custom Value en HighLevel:
                      <br />
                      1. Haz clic en "Add Custom Value"
                      <br />
                      2. Pon el nombre exacto (cópialo de arriba)
                      <br />
                      3. Pega el valor correspondiente
                      <br />
                      4. Guarda
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Paso 5 */}
            <div className={styles.tutorialStep}>
              <div
                className={styles.stepHeader}
                onClick={() => toggleSection(5)}
              >
                <div className={styles.stepNumber}>5</div>
                <div className={styles.stepInfo}>
                  <h4 className={styles.stepTitle}>Sincronizar y verificar</h4>
                  <p className={styles.stepSubtitle}>Trae tus datos de Meta a Ristak</p>
                </div>
                {openSection === 5 ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
              </div>

              {openSection === 5 && (
                <div className={styles.stepContent}>
                  <ol className={styles.stepList}>
                    <li>
                      <strong>Vuelve a la pestaña "HighLevel" en Configuración:</strong>
                      <ul>
                        <li>Ve a Configuración → HighLevel (la primera pestaña)</li>
                        <li>Haz clic en el botón <strong>"Sincronizar HighLevel"</strong></li>
                        <li>Esto traerá automáticamente tu configuración de Meta desde los Custom Values</li>
                        <li>Espera a que termine la sincronización</li>
                      </ul>
                    </li>
                    <li>
                      <strong>Ve a la página de Publicidad (Campaigns):</strong>
                      <ul>
                        <li>En el menú lateral, haz clic en "Publicidad"</li>
                        <li>Verás un botón "Sincronizar Meta Ads"</li>
                        <li>Haz clic para traer tus métricas de anuncios</li>
                        <li>La primera vez puede tardar varios minutos (trae datos históricos)</li>
                      </ul>
                    </li>
                  </ol>

                  <div className={styles.successBox}>
                    <CheckCircle size={18} />
                    <div>
                      <strong>¡Listo!</strong> A partir de ahora, Ristak sincronizará automáticamente tus métricas de Meta Ads
                      cada hora. Ya no necesitas entrar a Meta Business Manager para ver el rendimiento de tus anuncios.
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* FAQ */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Preguntas Frecuentes</h3>
          </div>
          <div className={styles.sectionContent}>
            <div className={styles.faqList}>
              <div className={styles.faqItem}>
                <h4 className={styles.faqQuestion}>¿El token del System User caduca?</h4>
                <p className={styles.faqAnswer}>
                  No, el token del System User NO caduca nunca (a menos que lo revques manualmente o cambies configuraciones de seguridad).
                  Por eso es la mejor opción para integraciones.
                </p>
              </div>

              <div className={styles.faqItem}>
                <h4 className={styles.faqQuestion}>¿Puedo usar un token normal en vez del System User?</h4>
                <p className={styles.faqAnswer}>
                  Sí, pero NO es recomendado. Los tokens normales de usuario caducan cada 60 días y tendrías que renovarlos manualmente.
                  El System User es más seguro y no requiere mantenimiento.
                </p>
              </div>

              <div className={styles.faqItem}>
                <h4 className={styles.faqQuestion}>¿Qué métricas trae Ristak de Meta Ads?</h4>
                <p className={styles.faqAnswer}>
                  Ristak trae: gasto (spend), alcance (reach), clics, CPC (costo por clic), CPM (costo por mil impresiones), CTR (click-through rate),
                  nombres de campañas, ad sets y anuncios. Todo organizado por fecha.
                </p>
              </div>

              <div className={styles.faqItem}>
                <h4 className={styles.faqQuestion}>¿Cada cuánto se actualizan los datos?</h4>
                <p className={styles.faqAnswer}>
                  Ristak sincroniza automáticamente los últimos 7 días de datos cada hora. Si quieres forzar una actualización manual,
                  ve a la página de Publicidad y haz clic en "Sincronizar Meta Ads".
                </p>
              </div>

              <div className={styles.faqItem}>
                <h4 className={styles.faqQuestion}>¿Es seguro guardar mi token en HighLevel?</h4>
                <p className={styles.faqAnswer}>
                  Sí. Los Custom Values de HighLevel están protegidos y solo son accesibles desde tu cuenta. Además, Ristak los guarda
                  cifrados en la base de datos local.
                </p>
              </div>

              <div className={styles.faqItem}>
                <h4 className={styles.faqQuestion}>¿Qué hago si me sale error al sincronizar?</h4>
                <p className={styles.faqAnswer}>
                  Primero verifica que los 4 Custom Values estén escritos EXACTAMENTE como se indica arriba (revisa mayúsculas, espacios y guiones).
                  Si el error persiste, revisa que tu System User tenga permisos de administrador en tu cuenta de anuncios.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Links útiles */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Links Útiles</h3>
          </div>
          <div className={styles.sectionContent}>
            <div className={styles.linksGrid}>
              <a
                href="https://developers.facebook.com"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.linkCard}
              >
                <span>Meta Developers</span>
                <ExternalLink size={16} />
              </a>
              <a
                href="https://business.facebook.com"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.linkCard}
              >
                <span>Meta Business Manager</span>
                <ExternalLink size={16} />
              </a>
              <a
                href="https://business.facebook.com/adsmanager"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.linkCard}
              >
                <span>Administrador de Anuncios</span>
                <ExternalLink size={16} />
              </a>
              <a
                href="https://developers.facebook.com/docs/marketing-api"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.linkCard}
              >
                <span>Documentación Marketing API</span>
                <ExternalLink size={16} />
              </a>
            </div>
          </div>
        </div>
      </Card>
    </div>
  )
}

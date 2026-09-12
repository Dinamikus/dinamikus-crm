// Las 6 etapas con las que arranca cualquier negocio nuevo — el admin las puede
// renombrar, reordenar, agregar más, o borrar las que no quiera (menos quitar la
// última etapa "por defecto", siempre debe quedar una).
export const DEFAULT_STAGES = [
  { key: 'new', label: 'Nuevo', position: 0, isDefault: true, isClosed: false },
  { key: 'contacted', label: 'En conversación', position: 1, isDefault: false, isClosed: false },
  { key: 'follow_up', label: 'Recontacto', position: 2, isDefault: false, isClosed: false },
  { key: 'appointment', label: 'Cita', position: 3, isDefault: false, isClosed: false },
  { key: 'won', label: 'Cierre', position: 4, isDefault: false, isClosed: true },
  { key: 'not_interested', label: 'No le interesa', position: 5, isDefault: false, isClosed: true }
];

export async function seedDefaultPipelineStages(client, tenantId) {
  for (const stage of DEFAULT_STAGES) {
    await client.query(
      `INSERT INTO pipeline_stages (tenant_id, key, label, position, is_default, is_closed)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [tenantId, stage.key, stage.label, stage.position, stage.isDefault, stage.isClosed]
    );
  }
}

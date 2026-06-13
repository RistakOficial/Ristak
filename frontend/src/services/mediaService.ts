import apiClient from './apiClient'

export interface MediaAsset {
  id: string
  publicUrl: string
  mimeType: string
  mediaType: string
  status: 'uploading' | 'processing' | 'ready' | 'failed' | 'deleted' | string
  sizeOriginal: number
  sizeProcessed: number
  quotaSize: number
}

export const mediaService = {
  uploadDataUrl(input: {
    fileBase64: string
    filename: string
    module?: string
    moduleEntityId?: string
    isPublic?: boolean
  }): Promise<MediaAsset> {
    return apiClient.post<MediaAsset>('/media/upload', {
      fileBase64: input.fileBase64,
      filename: input.filename,
      module: input.module || 'other',
      moduleEntityId: input.moduleEntityId,
      isPublic: input.isPublic ?? true
    })
  },

  getStorageUsage() {
    return apiClient.get('/media/storage/usage')
  }
}

export default mediaService


/** 读取一份 Blob。部分 WebView 仅提供 FileReader，读取失败时保留原始错误。 */
export const readBlobBuffer = (blob: Blob): Promise<ArrayBuffer> => {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer()
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () =>
      reject(reader.error ?? new DOMException('File read failed', 'NotReadableError'))
    reader.onabort = () => reject(new DOMException('File read aborted', 'AbortError'))
    reader.readAsArrayBuffer(blob)
  })
}

import type { ContentPart, ImagePart, MessageContent } from './types.ts'

/** Read the text of a message without caring whether it is stored as parts. */
export function textOf(content: MessageContent): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const part of content) {
    if (part.type === 'text' && part.text.length > 0) parts.push(part.text)
  }
  return parts.join('\n')
}

export function imagesOf(content: MessageContent): ImagePart[] {
  if (typeof content === 'string') return []
  const images: ImagePart[] = []
  for (const part of content) {
    if (part.type === 'image') images.push(part)
  }
  return images
}

export function isMultiPart(content: MessageContent): content is ContentPart[] {
  return Array.isArray(content)
}

/** `data:` URL for provider wire formats and browser `<img src>`. */
export function imageDataUrl(part: ImagePart): string {
  return `data:${part.mimeType};base64,${part.data}`
}

/** Wrap a text + optional images into message content, collapsing to a string. */
export function messageContent(text: string, images: ImagePart[] = []): MessageContent {
  if (images.length === 0) return text
  const parts: ContentPart[] = []
  if (text.length > 0) parts.push({ type: 'text', text })
  parts.push(...images)
  return parts
}

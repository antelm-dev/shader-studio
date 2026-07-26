export const SHADER_LIBRARY = Symbol('SHADER_LIBRARY');

// A textured shader's bundle inlines its channel images as base64 (~33%
// inflation), and a collection can hold many shaders.
export const BODY_LIMIT = '64mb';
export const TEXTURE_BODY_LIMIT = '4mb';
export const THUMBNAIL_BODY_LIMIT = '1mb';

// Vite "?url" imports resolve to the asset's URL string.
declare module '*?url' {
  const url: string;
  export default url;
}

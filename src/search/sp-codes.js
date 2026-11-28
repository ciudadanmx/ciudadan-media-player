// Códigos "sp" de la página de resultados de YouTube (parámetro de filtro de la
// propia web). Se aplican en el PROVEEDOR (YouTube filtra de verdad); los que no
// existen ahí se aplican en local y se marcan con scope:'local'.
// Vive en su propio módulo para que lo usen tanto la búsqueda directa (web)
// como el respaldo con yt-dlp.
export const SP = {
  type: { video: 'EgIQAQ==', channel: 'EgIQAg==', playlist: 'EgIQAw==', live: 'EgJAAQ==', movie: 'EgIQBA==' },
  sort: { date: 'CAI==', views: 'CAM==', rating: 'CAE==' },
  date: { hour: 'EgIIAQ==', today: 'EgIIAg==', week: 'EgIIAw==', month: 'EgIIBA==', year: 'EgIIBQ==' },
  duration: { short: 'EgIYAw==', medium: 'EgIYAf==', long: 'EgIYAg==' },
  features: { cc: 'EgIwAQ==', hd: 'EgI4AQ==', '4k': 'EgI4AQE==', live: 'EgJAAQ==', '360': 'EgI4AXAB', hdr: 'EgI4AZgB' },
};

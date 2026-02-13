// Tanzanian Regions and Councils data
const regionsAndCouncils = {
  "Arusha": [
    "Arusha City Council",
    "Arusha District Council",
    "Karatu District Council",
    "Longido District Council",
    "Meru District Council",
    "Monduli District Council",
    "Ngorongoro District Council"
  ],
  "Dar es Salaam": [
    "Ilala Municipal Council",
    "Kinondoni Municipal Council",
    "Temeke Municipal Council",
    "Ubungo Municipal Council",
    "Kigamboni Municipal Council"
  ],
  "Dodoma": [
    "Dodoma City Council",
    "Bahi District Council",
    "Chamwino District Council",
    "Chemba District Council",
    "Kondoa District Council",
    "Kongwa District Council",
    "Mpwapwa District Council"
  ],
  "Geita": [
    "Geita District Council",
    "Geita Town Council",
    "Bukombe District Council",
    "Chato District Council",
    "Mbogwe District Council",
    "Nyang'hwale District Council"
  ],
  "Iringa": [
    "Iringa Municipal Council",
    "Iringa District Council",
    "Kilolo District Council",
    "Mafinga Town Council",
    "Mufindi District Council"
  ],
  "Kagera": [
    "Bukoba Municipal Council",
    "Bukoba District Council",
    "Biharamulo District Council",
    "Karagwe District Council",
    "Kyerwa District Council",
    "Misenyi District Council",
    "Muleba District Council",
    "Ngara District Council"
  ],
  "Katavi": [
    "Mpanda Town Council",
    "Mlele District Council",
    "Nsimbo District Council"
  ],
  "Kigoma": [
    "Kigoma Municipal Council",
    "Kigoma District Council",
    "Buhigwe District Council",
    "Kakonko District Council",
    "Kasulu District Council",
    "Kibondo District Council",
    "Uvinza District Council"
  ],
  "Kilimanjaro": [
    "Moshi Municipal Council",
    "Hai District Council",
    "Moshi District Council",
    "Mwanga District Council",
    "Rombo District Council",
    "Same District Council",
    "Siha District Council"
  ],
  "Lindi": [
    "Lindi Municipal Council",
    "Lindi District Council",
    "Kilwa District Council",
    "Liwale District Council",
    "Nachingwea District Council",
    "Ruangwa District Council"
  ],
  "Manyara": [
    "Babati Town Council",
    "Babati District Council",
    "Hanang District Council",
    "Kiteto District Council",
    "Mbulu District Council",
    "Simanjiro District Council"
  ],
  "Mara": [
    "Musoma Municipal Council",
    "Bunda District Council",
    "Butiama District Council",
    "Musoma District Council",
    "Rorya District Council",
    "Serengeti District Council",
    "Tarime District Council"
  ],
  "Mbeya": [
    "Mbeya City Council",
    "Chunya District Council",
    "Ileje District Council",
    "Kyela District Council",
    "Mbarali District Council",
    "Mbeya District Council",
    "Mbozi District Council",
    "Rungwe District Council"
  ],
  "Morogoro": [
    "Morogoro Municipal Council",
    "Gairo District Council",
    "Malinyi District Council",
    "Kilombero District Council",
    "Kilosa District Council",
    "Morogoro District Council",
    "Mvomero District Council",
    "Ulanga District Council"
  ],
  "Mtwara": [
    "Mtwara Municipal Council",
    "Mtwara District Council",
    "Masasi District Council",
    "Nanyumbu District Council",
    "Newala District Council",
    "Tandahimba District Council"
  ],
  "Mwanza": [
    "Mwanza City Council",
    "Ilemela Municipal Council",
    "Kwimba District Council",
    "Magu District Council",
    "Misungwi District Council",
    "Nyamagana District Council",
    "Sengerema District Council",
    "Ukerewe District Council"
  ],
  "Njombe": [
    "Njombe Town Council",
    "Ludewa District Council",
    "Makete District Council",
    "Njombe District Council",
    "Wanging'ombe District Council"
  ],
  "Pemba North": [
    "Wete District Council",
    "Micheweni District Council"
  ],
  "Pemba South": [
    "Chake Chake District Council",
    "Mkoani District Council"
  ],
  "Pwani": [
    "Kibaha Town Council",
    "Bagamoyo District Council",
    "Kibaha District Council",
    "Kisarawe District Council",
    "Mafia District Council",
    "Mkuranga District Council",
    "Rufiji District Council"
  ],
  "Rukwa": [
    "Sumbawanga Municipal Council",
    "Kalambo District Council",
    "Nkasi District Council",
    "Sumbawanga District Council"
  ],
  "Ruvuma": [
    "Songea Municipal Council",
    "Mbinga District Council",
    "Namtumbo District Council",
    "Nyasa District Council",
    "Songea District Council",
    "Tunduru District Council"
  ],
  "Shinyanga": [
    "Shinyanga Municipal Council",
    "Kahama Town Council",
    "Bariadi District Council",
    "Bukombe District Council",
    "Kishapu District Council",
    "Maswa District Council",
    "Meatu District Council",
    "Shinyanga District Council"
  ],
  "Simiyu": [
    "Bariadi Town Council",
    "Bariadi District Council",
    "Busega District Council",
    "Itilima District Council",
    "Maswa District Council",
    "Meatu District Council"
  ],
  "Singida": [
    "Singida Municipal Council",
    "Iramba District Council",
    "Manyoni District Council",
    "Mkalama District Council",
    "Singida District Council"
  ],
  "Songwe": [
    "Vwawa Town Council",
    "Ileje District Council",
    "Mbozi District Council",
    "Momba District Council"
  ],
  "Tabora": [
    "Tabora Municipal Council",
    "Igunga District Council",
    "Kaliua District Council",
    "Nzega District Council",
    "Sikonge District Council",
    "Urambo District Council",
    "Uyui District Council"
  ],
  "Tanga": [
    "Tanga City Council",
    "Handeni District Council",
    "Kilindi District Council",
    "Korogwe District Council",
    "Lushoto District Council",
    "Mkinga District Council",
    "Muheza District Council",
    "Pangani District Council",
    "Tanga District Council"
  ],
 
};

// Helper function to validate region
const isValidRegion = (region) => {
  return region && Object.keys(regionsAndCouncils).includes(region);
};

// Helper function to validate council within a region
const isValidCouncil = (region, council) => {
  if (!region || !council) return false;
  const councils = regionsAndCouncils[region];
  return councils && councils.includes(council);
};

// Get all valid regions
const getValidRegions = () => Object.keys(regionsAndCouncils);

// Get councils for a region
const getCouncilsForRegion = (region) => regionsAndCouncils[region] || [];

module.exports = {
  regionsAndCouncils,
  isValidRegion,
  isValidCouncil,
  getValidRegions,
  getCouncilsForRegion
};

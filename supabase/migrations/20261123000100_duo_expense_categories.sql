begin;

create or replace function public.duo_notification_category(p_category text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(('{"supermercado":"Supermercado","verduleria":"Verdulería","panaderia":"Panadería","carniceria":"Carnicería","compras":"Shopping","bbva":"BBVA","santander":"Santander","galicia":"Galicia","uala":"Ualá","naranja-x":"Naranja X","banco-nacion":"Banco Nación","banco-provincia":"Banco Provincia","macro":"Macro","icbc":"ICBC","tarjeta-credito":"Otra tarjeta","tuenti":"Tuenti","personal-movil":"Personal","claro":"Claro","movistar":"Movistar","otro-celular":"Otro operador","monotributo":"Monotributo","indira":"Indira","luz":"Edesur","gas":"Metrogas","expensas":"Expensas","agua":"Agua","internet":"Internet","hogar":"Otros de casa","seguro":"Seguro","nafta":"Nafta","patente":"Patente","mecanico":"Mecánico","otros-auto":"Otros de auto","gym":"Gym","voley":"Vóley","padel":"Pádel","youtube":"YouTube","chatgpt":"ChatGPT","netflix":"Netflix","microsoft":"Microsoft","spotify":"Spotify","adobe":"Adobe","salidas":"Otros","vacaciones":"Vacaciones","salud":"Salud","expedicion-sonrisa":"Expedición Sonrisa","sube":"SUBE","otros":"Otros gastos","uber":"Uber","tren":"Tren","omnibus":"Ómnibus","heladeria":"Heladería","farmacia":"Farmacia","pedidos-ya":"Pedidos Ya","peaje":"Peaje","lavadero":"Lavadero","accesorios-auto":"Accesorios","comida":"Comida","cine":"Cine","teatro":"Teatro"}'::jsonb)->>p_category, 'Gasto compartido')
$$;
revoke all on function public.duo_notification_category(text) from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;

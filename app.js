/* ============================================================
   PIGEON NETWORK — MVP 1
   ============================================================
   CONFIGURACIÓN: reemplaza estos valores con los de tu proyecto
   Supabase (Project Settings > API). Usa SIEMPRE la clave
   "publishable" / "anon", NUNCA la service_role key.
   ============================================================ */
const SUPABASE_URL = "https://jvwzrmzdhyqkhdowoscl.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_0wqUosE3hgvRGyL26GeL9Q_diNCpErm";

/* ============================================================
   CONSTANTES DEL MUNDO
   ============================================================ */
const PIGEON_SPEED_KMH = 130;          // velocidad fija de toda paloma
const WORLD_HOUR_IN_REAL_SECONDS = 6;  // 1 hora del mundo = 6 segundos reales
const WORLD_MULTIPLIER = 600;          // 1 segundo real = 600 segundos del mundo (10 min)
const LOSS_PROBABILITY = 0.0005;       // 0.05% por tramo
const ARRIVAL_CHECK_MS = 1000;         // frecuencia de chequeo de llegada / render

const CITY_LABELS = { oaxaca: "Oaxaca", puebla: "Puebla", cdmx: "Ciudad de México" };

// Grafo de conexiones entre ciudades
const CITY_GRAPH = {
  oaxaca: ["puebla"],
  puebla: ["oaxaca", "cdmx"],
  cdmx: ["puebla"]
};

// Distancias fijas por tramo
const DISTANCES = {
  "oaxaca->puebla": 340,
  "puebla->oaxaca": 340,
  "puebla->cdmx": 130,
  "cdmx->puebla": 130
};

/* ============================================================
   ESTADO GLOBAL EN MEMORIA
   ============================================================ */
const state = {
  supabase: null,
  session: null,
  profile: null,        // { id, username, city }
  pigeons: [],
  messages: [],
  users: [],             // otros usuarios
  profilesMap: {},        // id -> { username, city }
  timeOffset: 0           // server_time - client_time (ms)
};

/* ============================================================
   INICIALIZACIÓN
   ============================================================ */
function initializeSupabase() {
  state.supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
}

async function initApp() {
  initializeSupabase();
  setupAuthUiListeners();
  setupFormListeners();

  await getSynchronizedTime();

  state.supabase.auth.onAuthStateChange(async (_event, session) => {
    state.session = session;
    if (session) {
      await onLogin();
    } else {
      showAuthScreen();
    }
  });

  const { data: { session } } = await state.supabase.auth.getSession();
  state.session = session;

  if (session) {
    await onLogin();
  } else {
    showAuthScreen();
  }

  setInterval(updateWorldClock, 1000);
  setInterval(tick, ARRIVAL_CHECK_MS);
}

document.addEventListener("DOMContentLoaded", initApp);

/* ============================================================
   SINCRONIZACIÓN DE TIEMPO
   ------------------------------------------------------------
   Hacemos una petición REST directa a Supabase y leemos el
   header "Date" de la respuesta HTTP, que refleja la hora del
   servidor. Con eso calculamos un offset que aplicamos sobre
   Date.now() en cada cliente, de forma que todos los
   dispositivos calculen aproximadamente el mismo tiempo del
   mundo (Pigeon World) sin depender de un reloj externo.
   ============================================================ */
async function getSynchronizedTime() {
  try {
    const clientBefore = Date.now();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id&limit=1`, {
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`
      }
    });
    const clientAfter = Date.now();
    const dateHeader = res.headers.get("date");
    if (dateHeader) {
      const serverTime = new Date(dateHeader).getTime();
      const clientApprox = (clientBefore + clientAfter) / 2;
      state.timeOffset = serverTime - clientApprox;
    } else {
      state.timeOffset = 0;
    }
  } catch (err) {
    console.error("No se pudo sincronizar el tiempo:", err);
    state.timeOffset = 0;
  }
}

// Tiempo real sincronizado entre dispositivos (ms desde epoch)
function getSynchronizedNow() {
  return Date.now() + state.timeOffset;
}

// Reloj visual: solo para mostrar, NO gobierna los vuelos
function updateWorldClock() {
  const realNow = new Date(getSynchronizedNow());
  const realStr = realNow.toTimeString().slice(0, 8);

  const worldMs = (getSynchronizedNow() * WORLD_MULTIPLIER) % 86400000;
  const worldDate = new Date(worldMs);
  const worldStr = worldDate.toISOString().slice(11, 16);

  const clockRealEl = document.getElementById("clockReal");
  const clockWorldEl = document.getElementById("clockWorld");
  if (clockRealEl) clockRealEl.textContent = realStr;
  if (clockWorldEl) clockWorldEl.textContent = worldStr;
}

/* ============================================================
   AUTENTICACIÓN
   ============================================================ */
function setupAuthUiListeners() {
  document.getElementById("showSignup").addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("loginCard").classList.add("hidden");
    document.getElementById("signupCard").classList.remove("hidden");
  });
  document.getElementById("showLogin").addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("signupCard").classList.add("hidden");
    document.getElementById("loginCard").classList.remove("hidden");
  });
  document.getElementById("logoutBtn").addEventListener("click", handleLogout);
}

function setupFormListeners() {
  document.getElementById("signupForm").addEventListener("submit", handleSignUp);
  document.getElementById("loginForm").addEventListener("submit", handleLogin);
  document.getElementById("messageForm").addEventListener("submit", sendMessage);
}

async function handleSignUp(e) {
  e.preventDefault();
  clearError();

  const username = document.getElementById("signupUsername").value.trim();
  const email = document.getElementById("signupEmail").value.trim();
  const password = document.getElementById("signupPassword").value;
  const city = document.getElementById("signupCity").value;

  if (!username || !email || !password || !city) {
    showError("Completa todos los campos.");
    return;
  }

  try {
    const { data, error } = await state.supabase.auth.signUp({ email, password });
    if (error) throw error;

    const userId = data.user ? data.user.id : null;
    if (!userId) {
      showError("Revisa tu correo para confirmar el registro y luego inicia sesión.");
      document.getElementById("signupCard").classList.add("hidden");
      document.getElementById("loginCard").classList.remove("hidden");
      return;
    }

    const { error: profileError } = await state.supabase
      .from("profiles")
      .insert({ id: userId, username, city });
    if (profileError) throw profileError;

    await createInitialPigeons(userId, city);

    showError("Registro exitoso. Ahora inicia sesión.", true);
    document.getElementById("signupCard").classList.add("hidden");
    document.getElementById("loginCard").classList.remove("hidden");
  } catch (err) {
    console.error(err);
    showError("Error al registrar el usuario.");
  }
}

async function createInitialPigeons(ownerId, city) {
  const pigeons = [1, 2, 3, 4, 5].map((n) => ({
    owner_id: ownerId,
    name: `Paloma ${n}`,
    status: "available",
    current_city: city
  }));
  const { error } = await state.supabase.from("pigeons").insert(pigeons);
  if (error) console.error("Error al crear palomas iniciales:", error);
}

async function handleLogin(e) {
  e.preventDefault();
  clearError();

  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;

  try {
    const { error } = await state.supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    // onAuthStateChange se encarga de llamar a onLogin()
  } catch (err) {
    console.error(err);
    showError("Error al iniciar sesión.");
  }
}

async function handleLogout() {
  await state.supabase.auth.signOut();
  showAuthScreen();
}

function showAuthScreen() {
  document.getElementById("authScreen").classList.remove("hidden");
  document.getElementById("dashboard").classList.add("hidden");
}

/* ============================================================
   CARGA DE DATOS TRAS LOGIN
   ============================================================ */
async function onLogin() {
  await getSynchronizedTime();
  await loadCurrentProfile();
  await loadAllProfiles();
  await loadPigeons();
  await loadMessages();

  document.getElementById("authScreen").classList.add("hidden");
  document.getElementById("dashboard").classList.remove("hidden");

  renderDashboard();
  subscribeToRealtime();
}

async function loadCurrentProfile() {
  const userId = state.session.user.id;
  const { data, error } = await state.supabase
    .from("profiles")
    .select("id, username, city, created_at")
    .eq("id", userId)
    .single();
  if (error) {
    console.error(error);
    showError("No se pudo cargar tu perfil.");
    return;
  }
  state.profile = data;
}

async function loadAllProfiles() {
  const { data, error } = await state.supabase
    .from("profiles")
    .select("id, username, city");
  if (error) {
    console.error(error);
    return;
  }
  state.profilesMap = {};
  data.forEach((p) => (state.profilesMap[p.id] = p));
  state.users = data.filter((p) => p.id !== state.profile.id);
}

async function loadPigeons() {
  const { data, error } = await state.supabase
    .from("pigeons")
    .select("id, owner_id, name, status, current_city, created_at")
    .eq("owner_id", state.profile.id)
    .order("name", { ascending: true });
  if (error) {
    console.error(error);
    return;
  }
  state.pigeons = data;
}

async function loadMessages() {
  const { data, error } = await state.supabase
    .from("messages")
    .select("*")
    .or(`sender_id.eq.${state.profile.id},receiver_id.eq.${state.profile.id}`)
    .order("created_at", { ascending: false });
  if (error) {
    console.error(error);
    return;
  }
  state.messages = data;
}

/* ============================================================
   RUTAS Y DURACIÓN DE VUELO
   ============================================================ */
function calculateRoute(originCity, destinationCity) {
  if (!CITY_GRAPH[originCity] || !CITY_GRAPH[destinationCity]) return null;
  if (originCity === destinationCity) return null;

  const queue = [[originCity]];
  const visited = new Set([originCity]);

  while (queue.length) {
    const path = queue.shift();
    const last = path[path.length - 1];
    if (last === destinationCity) return path;
    for (const neighbor of CITY_GRAPH[last]) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push([...path, neighbor]);
      }
    }
  }
  return null;
}

function getLegDistance(fromCity, toCity) {
  return DISTANCES[`${fromCity}->${toCity}`];
}

function calculateFlightDuration(distanceKm) {
  const worldHours = distanceKm / PIGEON_SPEED_KMH;
  const realMs = worldHours * WORLD_HOUR_IN_REAL_SECONDS * 1000;
  return { worldHours, realMs };
}

/* ============================================================
   ENVÍO DE MENSAJES
   ============================================================ */
async function sendMessage(e) {
  e.preventDefault();
  clearError();

  const receiverId = document.getElementById("recipientSelect").value;
  const content = document.getElementById("messageContent").value.trim();

  if (!receiverId) {
    showError("Selecciona un destinatario.");
    return;
  }
  if (receiverId === state.profile.id) {
    showError("No puedes enviarte una carta a ti mismo.");
    return;
  }
  if (!content) {
    showError("Escribe un mensaje.");
    return;
  }

  const originCity = state.profile.city;
  const destinationCity = state.profilesMap[receiverId]?.city;

  const route = calculateRoute(originCity, destinationCity);
  if (!route) {
    showError("No hay una ruta disponible entre estas ciudades.");
    return;
  }

  const availablePigeon = state.pigeons.find((p) => p.status === "available");
  if (!availablePigeon) {
    showError("No tienes palomas disponibles.");
    return;
  }

  try {
    const nextCity = route[1];
    const distance = getLegDistance(originCity, nextCity);
    const { realMs } = calculateFlightDuration(distance);

    const departure = new Date(getSynchronizedNow());
    const arrival = new Date(getSynchronizedNow() + realMs);

    const { error: msgError } = await state.supabase.from("messages").insert({
      sender_id: state.profile.id,
      receiver_id: receiverId,
      content,
      origin_city: originCity,
      destination_city: destinationCity,
      status: "flying",
      pigeon_id: availablePigeon.id,
      departure_time: departure.toISOString(),
      estimated_arrival_time: arrival.toISOString()
    });
    if (msgError) throw msgError;

    const { error: pigeonError } = await state.supabase
      .from("pigeons")
      .update({ status: "flying" })
      .eq("id", availablePigeon.id);
    if (pigeonError) throw pigeonError;

    document.getElementById("messageContent").value = "";
    await loadPigeons();
    await loadMessages();
    renderDashboard();
  } catch (err) {
    console.error(err);
    showError("Error al guardar la carta.");
  }
}

/* ============================================================
   PROCESAMIENTO DE VUELOS (SOLO EL DUEÑO DE LA PALOMA)
   ------------------------------------------------------------
   Por RLS, solo el dueño de una paloma puede modificar su fila
   en "pigeons". Por eso, cada cliente procesa únicamente los
   mensajes en los que ES el remitente (dueño de la paloma).
   El receptor solo lee "messages" (a la que sí tiene acceso) y
   se refresca vía Realtime / polling.
   ============================================================ */
function tick() {
  updateWorldClock();
  renderMessages();
  processArrivals();
}

async function processArrivals() {
  const now = getSynchronizedNow();
  const myFlyingAsSender = state.messages.filter(
    (m) => m.sender_id === state.profile.id && m.status === "flying"
  );

  for (const message of myFlyingAsSender) {
    const arrivalMs = new Date(message.estimated_arrival_time).getTime();
    if (now >= arrivalMs) {
      await handleArrival(message);
    }
  }
}

async function handleArrival(message) {
  const pigeon = state.pigeons.find((p) => p.id === message.pigeon_id);
  if (!pigeon) return;

  const route = calculateRoute(message.origin_city, message.destination_city);
  if (!route) return;

  const currentIndex = route.indexOf(pigeon.current_city);
  const nextCity = route[currentIndex + 1];
  if (!nextCity) return; // ya no hay más tramos por algún inconsistencia de datos

  const isFinalLeg = nextCity === message.destination_city;

  // Probabilidad de pérdida, decidida UNA sola vez por tramo, en el
  // momento en que se procesa su llegada (protegido por el guard
  // .eq('status','flying') más abajo, así nunca se re-evalúa).
  const isLost = Math.random() < LOSS_PROBABILITY;

  if (isLost) {
    await handlePigeonLost(message, pigeon);
    return;
  }

  if (isFinalLeg) {
    await deliverMessage(message, pigeon, nextCity);
  } else {
    await continueFlight(message, pigeon, route, nextCity);
  }
}

async function handlePigeonLost(message, pigeon) {
  const { data, error } = await state.supabase
    .from("messages")
    .update({ status: "lost" })
    .eq("id", message.id)
    .eq("status", "flying")
    .select();

  if (error) {
    console.error(error);
    return;
  }
  if (!data || data.length === 0) return; // ya procesado por otra pestaña

  const { error: pigeonError } = await state.supabase
    .from("pigeons")
    .update({ status: "lost" })
    .eq("id", pigeon.id);
  if (pigeonError) console.error(pigeonError);

  await loadPigeons();
  await loadMessages();
  renderDashboard();
}

async function deliverMessage(message, pigeon, destinationCity) {
  const now = new Date(getSynchronizedNow());

  const { data, error } = await state.supabase
    .from("messages")
    .update({ status: "delivered", delivered_at: now.toISOString() })
    .eq("id", message.id)
    .eq("status", "flying")
    .select();

  if (error) {
    console.error(error);
    return;
  }
  if (!data || data.length === 0) return; // ya procesado

  const { error: pigeonError } = await state.supabase
    .from("pigeons")
    .update({ status: "available", current_city: destinationCity })
    .eq("id", pigeon.id);
  if (pigeonError) console.error(pigeonError);

  await loadPigeons();
  await loadMessages();
  renderDashboard();
}

async function continueFlight(message, pigeon, route, nextCity) {
  const followingIndex = route.indexOf(nextCity) + 1;
  const followingCity = route[followingIndex];
  const distance = getLegDistance(nextCity, followingCity);
  const { realMs } = calculateFlightDuration(distance);

  const departure = new Date(getSynchronizedNow());
  const arrival = new Date(getSynchronizedNow() + realMs);

  const { data, error } = await state.supabase
    .from("messages")
    .update({
      departure_time: departure.toISOString(),
      estimated_arrival_time: arrival.toISOString()
    })
    .eq("id", message.id)
    .eq("status", "flying")
    .select();

  if (error) {
    console.error(error);
    return;
  }
  if (!data || data.length === 0) return; // ya procesado

  const { error: pigeonError } = await state.supabase
    .from("pigeons")
    .update({ current_city: nextCity })
    .eq("id", pigeon.id);
  if (pigeonError) console.error(pigeonError);

  await loadPigeons();
  await loadMessages();
  renderDashboard();
}

/* ============================================================
   REALTIME
   ============================================================ */
function subscribeToRealtime() {
  const userId = state.profile.id;

  state.supabase
    .channel("pigeon-messages-sender")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "messages", filter: `sender_id=eq.${userId}` },
      handleRealtimeChange
    )
    .subscribe();

  state.supabase
    .channel("pigeon-messages-receiver")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "messages", filter: `receiver_id=eq.${userId}` },
      handleRealtimeChange
    )
    .subscribe();

  state.supabase
    .channel("pigeon-pigeons-owner")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "pigeons", filter: `owner_id=eq.${userId}` },
      handleRealtimeChange
    )
    .subscribe();
}

async function handleRealtimeChange() {
  await loadPigeons();
  await loadMessages();
  renderDashboard();
}

/* ============================================================
   RENDERIZADO
   ============================================================ */
function renderDashboard() {
  document.getElementById("infoUsername").textContent = "@" + state.profile.username;
  document.getElementById("infoCity").textContent = CITY_LABELS[state.profile.city];

  renderPigeons();
  renderUsers();
  renderMessages();
}

function renderPigeons() {
  const list = document.getElementById("pigeonsList");
  const available = state.pigeons.filter((p) => p.status === "available").length;
  document.getElementById("pigeonCount").textContent = `(${available}/${state.pigeons.length} disponibles)`;

  list.innerHTML = "";
  state.pigeons.forEach((p) => {
    const div = document.createElement("div");
    div.className = "pigeon-item";
    const statusLabel =
      p.status === "available" ? "Disponible" : p.status === "flying" ? "Volando" : "Perdida";
    div.innerHTML = `🐦 ${p.name} — <span class="status-${p.status}">${statusLabel}</span> (${CITY_LABELS[p.current_city] || p.current_city})`;
    list.appendChild(div);
  });
}

function renderUsers() {
  const list = document.getElementById("usersList");
  const select = document.getElementById("recipientSelect");

  list.innerHTML = "";
  select.innerHTML = '<option value="">Selecciona destinatario</option>';

  state.users.forEach((u) => {
    const div = document.createElement("div");
    div.className = "user-item";
    div.textContent = `@${u.username} — ${CITY_LABELS[u.city]}`;
    list.appendChild(div);

    const option = document.createElement("option");
    option.value = u.id;
    option.textContent = `@${u.username} (${CITY_LABELS[u.city]})`;
    select.appendChild(option);
  });
}

function renderMessages() {
  const list = document.getElementById("messagesList");
  if (!list) return;
  list.innerHTML = "";

  state.messages.forEach((m) => {
    const div = document.createElement("div");
    div.className = "message-item";

    const isSender = m.sender_id === state.profile.id;
    const otherId = isSender ? m.receiver_id : m.sender_id;
    const otherUsername = state.profilesMap[otherId]?.username || "?";

    let statusHtml = "";
    if (m.status === "flying") {
      const progress = computeProgress(m);
      const eta = new Date(m.estimated_arrival_time).toTimeString().slice(0, 5);
      statusHtml = `
        <div class="status-flying">🐦 Volando — ${Math.round(progress * 100)}%</div>
        <div class="progress-bar"><div class="progress-fill" style="width:${progress * 100}%"></div></div>
        <div>ETA: ${eta}</div>
      `;
    } else if (m.status === "delivered") {
      statusHtml = `<div class="status-delivered">✅ Carta entregada</div>`;
    } else if (m.status === "lost") {
      statusHtml = `<div class="status-lost">🐦 La paloma se perdió durante el vuelo.</div>`;
    }

    div.innerHTML = `
      <strong>${isSender ? "Para" : "De"}: @${otherUsername}</strong><br>
      Ruta: ${CITY_LABELS[m.origin_city]} → ${CITY_LABELS[m.destination_city]}<br>
      ${!isSender && m.status === "delivered" ? `<em>"${escapeHtml(m.content)}"</em><br>` : ""}
      ${statusHtml}
    `;
    list.appendChild(div);
  });
}

function computeProgress(message) {
  const now = getSynchronizedNow();
  const departure = new Date(message.departure_time).getTime();
  const arrival = new Date(message.estimated_arrival_time).getTime();
  if (arrival === departure) return 1;
  let progress = (now - departure) / (arrival - departure);
  if (progress < 0) progress = 0;
  if (progress > 1) progress = 1;
  return progress;
}

/* ============================================================
   UTILIDADES
   ============================================================ */
function showError(msg, isInfo) {
  const box = document.getElementById("errorBox");
  box.textContent = msg;
  box.classList.remove("hidden");
  box.style.background = isInfo ? "#e2f0d9" : "#ffe1e1";
  box.style.color = isInfo ? "#2f6b2f" : "#a33";
}

function clearError() {
  const box = document.getElementById("errorBox");
  box.classList.add("hidden");
  box.textContent = "";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

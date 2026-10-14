import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, collection, addDoc, updateDoc, onSnapshot, query, where, orderBy, limit, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import * as cfg from "./config.js";
const { firebaseConfig, ADMIN_EMAIL } = cfg;

// Avisa o motorista pelo ntfy.sh (notificação com o app fechado)
async function avisarMotorista(nome){
  if (!cfg.NTFY_TOPIC || cfg.NTFY_TOPIC.includes("COLE")) return;
  try {
    await fetch("https://ntfy.sh/", { method:"POST", body: JSON.stringify({
      topic: cfg.NTFY_TOPIC, title: "LZ EXPRESS - Novo chamado!",
      message: nome + " está chamando um moto táxi.", priority: 5, tags: ["motorcycle"],
      click: location.origin + location.pathname
    })});
  } catch {}
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

let modoCadastro = false, unsub = null, audioCtx = null;

function tela(id){ ["loading","auth","cliente","motorista"].forEach(t => $(t).classList.toggle("hidden", t !== id)); }
function erroMsg(e){
  const m = {
    "auth/invalid-email":"E-mail inválido. Confira se digitou certo.",
    "auth/missing-password":"Digite sua senha.",
    "auth/weak-password":"A senha precisa ter pelo menos 6 caracteres.",
    "auth/email-already-in-use":"Este e-mail já tem cadastro. Toque em “Entrar”.",
    "auth/invalid-credential":"E-mail ou senha incorretos.",
    "auth/user-not-found":"E-mail ou senha incorretos.",
    "auth/wrong-password":"E-mail ou senha incorretos.",
    "auth/too-many-requests":"Muitas tentativas. Aguarde um pouco e tente de novo.",
    "auth/network-request-failed":"Sem internet. Verifique sua conexão."
  };
  return m[e.code] || "Algo deu errado. Tente novamente.";
}

/* ---------- Login / cadastro ---------- */
function setModo(cad){
  modoCadastro = cad;
  $("aba-entrar").classList.toggle("ativa", !cad);
  $("aba-criar").classList.toggle("ativa", cad);
  $("campos-cadastro").classList.toggle("hidden", !cad);
  $("btn-auth").textContent = cad ? "Criar minha conta" : "Entrar";
  $("senha").autocomplete = cad ? "new-password" : "current-password";
  $("erro").textContent = "";
}
$("aba-entrar").onclick = () => setModo(false);
$("aba-criar").onclick = () => setModo(true);

$("btn-auth").onclick = async () => {
  const email = $("email").value.trim(), senha = $("senha").value;
  const nome = $("nome").value.trim(), telefone = $("telefone").value.trim();
  $("erro").textContent = "";
  if (!email || !senha) { $("erro").textContent = "Preencha e-mail e senha."; return; }
  if (modoCadastro && (!nome || !telefone)) { $("erro").textContent = "Preencha seu nome e telefone."; return; }
  $("btn-auth").disabled = true;
  try {
    if (modoCadastro) {
      const c = await createUserWithEmailAndPassword(auth, email, senha);
      await setDoc(doc(db, "users", c.user.uid), { nome, telefone, email, criadoEm: serverTimestamp() });
    } else {
      await signInWithEmailAndPassword(auth, email, senha);
    }
  } catch (e) { $("erro").textContent = erroMsg(e); }
  $("btn-auth").disabled = false;
};

$("btn-esqueci").onclick = async () => {
  const email = $("email").value.trim();
  if (!email) { $("erro").textContent = "Digite seu e-mail acima e toque de novo."; return; }
  try { await sendPasswordResetEmail(auth, email); $("erro").style.color = "#2E7D5B"; $("erro").textContent = "Enviamos um e-mail para criar nova senha."; }
  catch (e) { $("erro").style.color = ""; $("erro").textContent = erroMsg(e); }
};

document.querySelectorAll("[data-sair]").forEach(b => b.onclick = () => signOut(auth));

onAuthStateChanged(auth, async user => {
  if (unsub) { unsub(); unsub = null; }
  if (!user) { tela("auth"); return; }
  if (user.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) { iniciarMotorista(); tela("motorista"); }
  else { iniciarCliente(user); tela("cliente"); }
});

/* ---------- Cliente ---------- */
const TEXTOS = {
  aguardando:["Procurando o moto táxi...","Seu chamado foi enviado. Aguarde um instante.",""],
  aceito:["Moto a caminho! 🏍️","O moto táxi aceitou e está indo até você. Fique no local.","aceito"],
  finalizado:["Corrida finalizada","Obrigado por usar o LZ EXPRESS!","final"],
  cancelado:["Chamado cancelado","Você pode chamar novamente quando quiser.","final"]
};
function iniciarCliente(user){
  getDoc(doc(db,"users",user.uid)).then(s => { $("ola").textContent = "Olá, " + (s.exists() ? s.data().nome.split(" ")[0] : "") + "!"; }).catch(()=>{});
  let ativo = null;
  unsub = onSnapshot(query(collection(db,"chamados"), where("uid","==",user.uid)), snap => {
    const todos = snap.docs.map(d => ({id:d.id, ...d.data()}));
    todos.sort((a,b) => (b.criadoEm?.seconds ?? 9e9) - (a.criadoEm?.seconds ?? 9e9));
    const ult = todos[0];
    ativo = ult && ["aguardando","aceito"].includes(ult.status) ? ult : null;
    $("btn-chamar").classList.toggle("hidden", !!ativo);
    $("btn-cancelar").classList.toggle("hidden", !(ativo && ativo.status === "aguardando"));
    if (!ult) { $("status").classList.add("hidden"); return; }
    const t = TEXTOS[ult.status] || TEXTOS.aguardando;
    $("status").className = "status " + t[2];
    $("status-titulo").textContent = t[0]; $("status-texto").textContent = t[1];
  }, () => alert("Não foi possível carregar. Verifique a internet."));

  $("btn-cancelar").onclick = () => ativo && updateDoc(doc(db,"chamados",ativo.id), { status:"cancelado" });
  $("btn-chamar").onclick = async () => {
    const btn = $("btn-chamar");
    if (!navigator.geolocation) { alert("Seu celular não permite localização."); return; }
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(async pos => {
      try {
        const s = await getDoc(doc(db,"users",user.uid));
        const u = s.exists() ? s.data() : {nome:"Cliente", telefone:""};
        await addDoc(collection(db,"chamados"), {
          uid:user.uid, nome:u.nome, telefone:u.telefone,
          lat:pos.coords.latitude, lng:pos.coords.longitude, precisao:Math.round(pos.coords.accuracy),
          status:"aguardando", criadoEm:serverTimestamp()
        });
        avisarMotorista((u.nome||"Cliente").split(" ")[0]);
      } catch { alert("Não foi possível enviar o chamado. Tente de novo."); }
      btn.disabled = false;
    }, err => {
      btn.disabled = false;
      alert(err.code === 1 ? "Você não permitiu a localização. Toque no cadeado do navegador, permita a localização e tente de novo." : "Não conseguimos achar sua localização. Vá para um local aberto e tente de novo.");
    }, { enableHighAccuracy:true, timeout:20000, maximumAge:0 });
  };
}

/* ---------- Motorista ---------- */
function beep(){
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    [0,0.35,0.7].forEach(t => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.4, audioCtx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t + 0.3);
      o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.3);
    });
    navigator.vibrate && navigator.vibrate([300,150,300]);
  } catch {}
}
function hora(c){ return c.criadoEm ? new Date(c.criadoEm.seconds*1000).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}) : "agora"; }

function iniciarMotorista(){
  let primeira = true;
  unsub = onSnapshot(query(collection(db,"chamados"), orderBy("criadoEm","desc"), limit(50)), snap => {
    if (!primeira && snap.docChanges().some(c => c.type === "added" && c.doc.data().status === "aguardando")) beep();
    primeira = false;
    const itens = snap.docs.map(d => ({id:d.id, ...d.data()}));
    $("lista").innerHTML = itens.length ? itens.map(c => {
      const fim = ["finalizado","cancelado"].includes(c.status);
      const fone = (c.telefone||"").replace(/\D/g,"");
      return `<div class="chamado ${c.status==="aceito"?"aceito":""} ${fim?"fim":""}">
        <h3>${esc(c.nome)}</h3>
        <div class="info">${hora(c)} · ${esc(c.status)} · precisão ~${c.precisao ?? "?"} m<br>${esc(c.telefone)}</div>
        ${fim ? "" : `<div class="acoes">
          <a class="b-mapa" target="_blank" href="https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}">📍 Google Maps</a>
          <a class="b-waze" target="_blank" href="https://waze.com/ul?ll=${c.lat},${c.lng}&navigate=yes">🚗 Waze</a>
          <a class="b-zap" target="_blank" href="https://wa.me/55${fone}">💬 WhatsApp</a>
          ${c.status==="aguardando" ? `<button class="b-ok" data-a="aceito" data-id="${c.id}">✔ Aceitar</button>` : `<button class="b-fim" data-a="finalizado" data-id="${c.id}">🏁 Finalizar</button>`}
        </div>`}
      </div>`;
    }).join("") : `<p class="vazio">Nenhum chamado por enquanto.</p>`;
  }, e => alert("Erro ao carregar chamados: " + e.code));
}
$("lista").addEventListener("click", e => {
  const b = e.target.closest("button[data-id]"); if (!b) return;
  updateDoc(doc(db,"chamados",b.dataset.id), { status:b.dataset.a });
});
document.addEventListener("click", () => { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); }, { once:true });

/* ---------- PWA ---------- */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
let promptInstalar;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); promptInstalar = e; $("instalar").classList.remove("hidden"); });
$("btn-instalar").onclick = async () => { $("instalar").classList.add("hidden"); promptInstalar?.prompt(); };

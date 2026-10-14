import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, collection, addDoc, updateDoc, onSnapshot, query, where, orderBy, limit, serverTimestamp, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { PIX_PAYLOAD } from "./pix.js";
import { MOTORISTA_NOME, MOTORISTA_ZAP } from "./motorista.js";
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

let modoCadastro = false, unsubs = [], audioCtx = null;
const parar = () => { unsubs.forEach(f => f()); unsubs = []; };

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
const imgLogo = new Image();
imgLogo.onload = () => $("auth").classList.add("com-logo");
imgLogo.src = "assets/fundo.png";
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

$("ver-senha").onclick = () => {
  const ver = $("senha").type === "password";
  $("senha").type = ver ? "text" : "password";
  $("ver-senha").textContent = ver ? "Ocultar" : "Mostrar";
};

document.querySelectorAll("[data-sair]").forEach(b => b.onclick = () => signOut(auth));

onAuthStateChanged(auth, async user => {
  parar();
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
const MOTIVOS_CLIENTE = {
  nao_encontrado:"Não conseguimos te encontrar. Chame de novo e escreva um ponto de referência.",
  fora_area:"Desculpe, seu local está fora da área de atendimento."
};
function textoStatus(c){
  if (c.status === "aguardando" && c.aviso === "aguardar") return ["Aguarde um pouquinho","O moto táxi está terminando outra corrida. Pode aguardar, já vamos até você!",""];
  if (c.status === "aceito") return ["Moto a caminho! 🏍️", MOTORISTA_NOME + " aceitou seu chamado e está indo até você. Fique no local.","aceito"];
  if (c.status === "cancelado" && MOTIVOS_CLIENTE[c.motivo]) return ["Chamado cancelado", MOTIVOS_CLIENTE[c.motivo], "final"];
  return TEXTOS[c.status] || TEXTOS.aguardando;
}
function iniciarCliente(user){
  getDoc(doc(db,"users",user.uid)).then(s => { $("ola").textContent = "Olá, " + (s.exists() ? s.data().nome.split(" ")[0] : "") + "!"; }).catch(()=>{});
  let ativo = null, online = null;
  const atualizarBotao = () => {
    $("bloco-chamar").classList.toggle("hidden", !!ativo || online !== true);
    $("aviso-offline").classList.toggle("hidden", !!ativo || online !== false);
  };
  unsubs.push(onSnapshot(doc(db,"config","status"),
    s => { online = s.exists() && s.data().online === true; atualizarBotao(); },
    () => { online = false; atualizarBotao(); }));
  unsubs.push(onSnapshot(query(collection(db,"chamados"), where("uid","==",user.uid)), snap => {
    const todos = snap.docs.map(d => ({id:d.id, ...d.data()}));
    todos.sort((a,b) => (b.criadoEm?.seconds ?? 9e9) - (a.criadoEm?.seconds ?? 9e9));
    const ult = todos[0];
    ativo = ult && ["aguardando","aceito"].includes(ult.status) ? ult : null;
    atualizarBotao();
    $("btn-cancelar").classList.toggle("hidden", !(ativo && ativo.status === "aguardando"));
    if (!ult) { $("status").classList.add("hidden"); return; }
    const t = textoStatus(ult);
    $("status").className = "status " + t[2];
    $("status-titulo").textContent = t[0]; $("status-texto").textContent = t[1];
    const zap = String(MOTORISTA_ZAP || "").replace(/\D/g,"");
    $("btn-zap-mot").classList.toggle("hidden", !(ult.status === "aceito" && zap));
    $("btn-zap-mot").href = "https://wa.me/" + zap;
  }, () => alert("Não foi possível carregar. Verifique a internet.")));

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
          uid:user.uid, nome:u.nome, telefone:u.telefone, referencia:$("referencia").value.trim().slice(0,120),
          lat:pos.coords.latitude, lng:pos.coords.longitude, precisao:Math.round(pos.coords.accuracy),
          status:"aguardando", criadoEm:serverTimestamp()
        });
        avisarMotorista((u.nome||"Cliente").split(" ")[0]);
        $("referencia").value = "";
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
const fmt = (t, soHora) => !t ? "agora" : new Date(t.seconds*1000).toLocaleString("pt-BR",
  soHora ? {hour:"2-digit",minute:"2-digit"} : {day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
const MOT_TXT = {nao_encontrado:"cliente não encontrado", fora_area:"fora da área"};
const NOMES = {aguardando:"Aguardando",aceito:"Em andamento",finalizado:"Finalizada",cancelado:"Cancelada"};
function abaMot(qual){
  [["ativos","aba-ativos","lista"],["hist","aba-hist","hist"],["clientes","aba-clientes","clientes"]].forEach(([n,aba,box]) => {
    $(aba).classList.toggle("ativa", n === qual); $(box).classList.toggle("hidden", n !== qual);
  });
}

function iniciarMotorista(){
  let primeira = true, online = false, histAtual = [];
  const btn = $("btn-online");
  const atualizarApagar = () => {
    $("btn-apagar").disabled = online || !histAtual.length;
    $("aviso-apagar").textContent = "Fique offline para apagar o histórico.";
    $("aviso-apagar").classList.toggle("hidden", !online || !histAtual.length);
  };
  unsubs.push(onSnapshot(doc(db,"config","status"), s => {
    online = s.exists() && s.data().online === true;
    btn.className = "toggle " + (online ? "on" : "off");
    btn.textContent = online ? "🟢 ONLINE - toque para ficar offline" : "🔴 OFFLINE - toque para ficar online";
    atualizarApagar();
  }));
  btn.onclick = () => setDoc(doc(db,"config","status"), { online: !online, atualizadoEm: serverTimestamp() }).catch(() => alert("Não foi possível mudar o status."));
  $("aba-ativos").onclick = () => abaMot("ativos");
  $("aba-hist").onclick = () => abaMot("hist");
  $("aba-clientes").onclick = () => abaMot("clientes");
  let clientes = [];
  const mostrarClientes = () => {
    const q = $("busca-cliente").value.trim().toLowerCase();
    const lista = clientes.filter(c => !q || (c.nome||"").toLowerCase().includes(q) || (c.telefone||"").includes(q));
    $("lista-clientes").innerHTML = lista.length ? lista.map(c => {
      const fone = (c.telefone||"").replace(/\D/g,"");
      return `<div class="chamado aceito"><h3>${esc(c.nome)}</h3><div class="info">${esc(c.telefone)}</div>
        <div class="acoes"><a class="b-zap" target="_blank" href="https://wa.me/55${fone}" style="grid-column:1/3">💬 WhatsApp</a></div></div>`;
    }).join("") : `<p class="vazio">Nenhum cliente encontrado.</p>`;
  };
  $("busca-cliente").oninput = mostrarClientes;
  unsubs.push(onSnapshot(collection(db,"users"), snap => {
    clientes = snap.docs.map(d => d.data()).filter(c => (c.email||"").toLowerCase() !== ADMIN_EMAIL.toLowerCase())
      .sort((a,b) => (a.nome||"").localeCompare(b.nome||"","pt-BR"));
    mostrarClientes();
  }, () => {}));
  $("btn-apagar").onclick = async () => {
    if (online || !histAtual.length) return;
    if (!confirm("Apagar " + histAtual.length + " corridas do histórico? Isso não pode ser desfeito.")) return;
    try {
      const lote = writeBatch(db);
      histAtual.forEach(c => lote.delete(doc(db,"chamados",c.id)));
      await lote.commit();
    } catch { alert("Não foi possível apagar. Tente de novo."); }
  };

  unsubs.push(onSnapshot(query(collection(db,"chamados"), orderBy("criadoEm","desc"), limit(100)), snap => {
    if (!primeira && snap.docChanges().some(c => c.type === "added" && c.doc.data().status === "aguardando")) beep();
    primeira = false;
    const itens = snap.docs.map(d => ({id:d.id, ...d.data()}));
    const ativos = itens.filter(c => ["aguardando","aceito"].includes(c.status));
    const hist = itens.filter(c => !ativos.includes(c));
    histAtual = hist; atualizarApagar();
    $("lista").innerHTML = ativos.length ? ativos.map(c => {
      const fone = (c.telefone||"").replace(/\D/g,"");
      return `<div class="chamado ${c.status==="aceito"?"aceito":""}">
        <h3>${esc(c.nome)}</h3>
        <div class="info">${fmt(c.criadoEm)} · ${NOMES[c.status]} · precisão ~${c.precisao ?? "?"} m<br>${esc(c.telefone)}</div>
        ${c.referencia ? `<div class="ref">📌 Referência: ${esc(c.referencia)}</div>` : ""}
        <div class="acoes">
          <a class="b-mapa" target="_blank" href="https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}">📍 Google Maps</a>
          <a class="b-waze" target="_blank" href="https://waze.com/ul?ll=${c.lat},${c.lng}&navigate=yes">🚗 Waze</a>
          <a class="b-zap" target="_blank" href="https://wa.me/55${fone}">💬 WhatsApp</a>
          ${c.status==="aguardando" ? `<button class="b-ok" data-a="aceito" data-id="${c.id}">✔ Aceitar</button>` : `<button class="b-fim" data-a="finalizado" data-id="${c.id}">🏁 Finalizar</button>`}
          ${c.status==="aguardando" ? `<button class="b-esp" data-a="aguardar" data-id="${c.id}" style="grid-column:1/3" ${c.aviso==="aguardar"?"disabled":""}>${c.aviso==="aguardar"?"⏳ Cliente avisado para aguardar":"⏳ Estou em outra corrida"}</button>` : ""}
          <button class="b-cancel" data-a="cancelar" data-id="${c.id}" style="grid-column:1/3">✖ Cancelar chamado</button>
        </div></div>`;
    }).join("") : `<p class="vazio">Nenhum chamado por enquanto.</p>`;
    const hoje = new Date().toDateString();
    const feitasHoje = hist.filter(c => c.status === "finalizado" && c.criadoEm && new Date(c.criadoEm.seconds*1000).toDateString() === hoje).length;
    $("resumo").textContent = `Corridas finalizadas hoje: ${feitasHoje} · No histórico: ${hist.length}`;
    $("lista-hist").innerHTML = hist.length ? hist.map(c => `<div class="chamado ${c.status==="finalizado"?"aceito":"fim"}">
        <h3>${esc(c.nome)}</h3>
        <div class="info">${fmt(c.criadoEm)} · ${NOMES[c.status]}${MOT_TXT[c.motivo] ? " ("+MOT_TXT[c.motivo]+")" : ""}<br>${esc(c.telefone)}${c.finalizadoEm ? `<br>Encerrada às ${fmt(c.finalizadoEm,true)}` : ""}</div>
        ${c.status==="finalizado" ? `<div class="acoes"><button class="b-ok" data-pix="1" style="grid-column:1/3">💲 Receber por Pix</button></div>` : ""}</div>`).join("")
      : `<p class="vazio">Nenhuma corrida no histórico ainda.</p>`;
  }, e => alert("Erro ao carregar chamados: " + e.code)));
}
let cancelId = null;
$("lista").addEventListener("click", e => {
  const b = e.target.closest("button[data-id]"); if (!b) return;
  const a = b.dataset.a, ref = doc(db,"chamados",b.dataset.id);
  if (a === "cancelar") { cancelId = b.dataset.id; $("cancel-tela").classList.remove("hidden"); return; }
  if (a === "aguardar") { updateDoc(ref, { aviso:"aguardar" }); return; }
  const extra = a === "aceito" ? { aceitoEm: serverTimestamp(), aviso:"" } : { finalizadoEm: serverTimestamp() };
  updateDoc(ref, { status:a, ...extra });
  if (a === "finalizado") abaMot("hist");
});
$("cancel-tela").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.motivo && cancelId) updateDoc(doc(db,"chamados",cancelId), { status:"cancelado", motivo:b.dataset.motivo, finalizadoEm: serverTimestamp() });
  cancelId = null; $("cancel-tela").classList.add("hidden");
});

/* ---------- Pix ---------- */
let qrFeito = false;
$("lista-hist").addEventListener("click", e => {
  if (!e.target.closest("[data-pix]")) return;
  if (!qrFeito && window.QRCode) {
    new QRCode($("pix-qr"), { text: PIX_PAYLOAD, width: 260, height: 260, correctLevel: QRCode.CorrectLevel.M });
    qrFeito = true;
  } else if (!window.QRCode) { $("pix-qr").textContent = "Sem internet para gerar o QR. Use o botão abaixo para copiar o código Pix."; }
  $("pix-tela").classList.remove("hidden");
});
$("pix-fechar").onclick = () => $("pix-tela").classList.add("hidden");
$("pix-copiar").onclick = async () => {
  try { await navigator.clipboard.writeText(PIX_PAYLOAD); $("pix-copiar").textContent = "Código copiado!"; }
  catch { prompt("Copie o código Pix:", PIX_PAYLOAD); }
  setTimeout(() => $("pix-copiar").textContent = "Copiar código Pix", 2000);
};
document.addEventListener("click", () => { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); }, { once:true });

/* ---------- PWA ---------- */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
let promptInstalar;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); promptInstalar = e; $("instalar").classList.remove("hidden"); });
$("btn-instalar").onclick = async () => { $("instalar").classList.add("hidden"); promptInstalar?.prompt(); };

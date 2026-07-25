# Painel Tático — PWA

## O que é
App instalável no Android (e testável no PC) com os KPIs de xadrez: análise por partida,
últimas 20, histórico completo, e as 5 recomendações práticas. Dados salvos no `localStorage`
do navegador — ficam só no aparelho onde você usar. Use "Exportar backup" / "Importar" para
mover dados entre PC e celular manualmente.

## Passo a passo: colocar no ar (GitHub Pages, grátis)

1. Crie uma conta no GitHub (github.com) se ainda não tiver.
2. Crie um repositório novo, público, nome sugerido: `painel-tatico`.
3. Faça upload de TODOS os arquivos desta pasta (`index.html`, `manifest.json`, `sw.js`, a pasta
   `js/`, a pasta `icons/`) mantendo a mesma estrutura — pelo botão "Add file → Upload files" no
   GitHub, direto pelo navegador, sem precisar instalar git.
4. Vá em **Settings → Pages** do repositório.
5. Em "Source", selecione **Deploy from a branch**, branch `main`, pasta `/ (root)`. Salve.
6. Espere 1-2 minutos. O GitHub mostra a URL final, algo como:
   `https://SEU-USUARIO.github.io/painel-tatico/`

Essa URL é HTTPS — obrigatório para o Android permitir instalar como app.

## Instalar no Android

1. Abra a URL do GitHub Pages no **Chrome** do celular.
2. Um aviso "Instalar app no dispositivo" deve aparecer na parte de baixo da tela (ou vá no
   menu ⋮ do Chrome → "Instalar app" / "Adicionar à tela inicial").
3. Confirme. O ícone aparece na tela inicial como um app normal, abre em tela cheia, sem barra
   do navegador.

## Testar no PC

- Abra a mesma URL em qualquer navegador (Chrome, Edge). Funciona direto.
- No Chrome/Edge desktop também é instalável: ícone de instalação aparece na barra de endereço.

## Testar localmente antes de subir (opcional)

Se quiser conferir antes de publicar, dá para rodar um servidor local simples. Isso exige um
terminal — se não tiver familiaridade, pule direto para o GitHub Pages, que é mais simples.

```
cd pasta-do-projeto
python3 -m http.server 8080
```

Depois abra `http://localhost:8080` no navegador. Atenção: instalação como PWA geralmente exige
HTTPS, então localhost funciona para visualizar mas pode não mostrar o prompt de instalação —
isso é normal, o GitHub Pages resolve isso.

## Limitações desta versão

- **Sem sincronização automática** entre dispositivos — cada aparelho tem seu próprio banco de
  dados local. Use exportar/importar para mover dados manualmente.
- **Modo "Stockfish.js no navegador"** está na interface mas não roda análise real nesta versão
  (ficaria pesado para este primeiro teste) — ele cai automaticamente no modo "sem engine" e avisa
  isso na nota da partida.
- **Modo "API do Lichess"** importa a partida para o Lichess e te dá o link, mas a extração
  automática dos resultados da análise deles de volta pro app ainda não está implementada — por
  enquanto ele documenta o link e usa as anotações do PGN para os KPIs.

## Próximos passos possíveis
- Sincronização real (precisaria de um backend pequeno — dá para usar Supabase ou Firebase grátis)
- Stockfish.js rodando de fato local para partidas sem anotações prontas
- Extração automática do resultado da análise do Lichess via API deles

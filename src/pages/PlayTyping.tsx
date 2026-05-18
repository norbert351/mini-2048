import { useState, useCallback, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTypingGame, WordMode } from '@/hooks/useTypingGame';
import { WalletConnect } from '@/components/game/WalletConnect';
import { PaymentModal, PaymentToken } from '@/components/game/PaymentModal';
import { Button } from '@/components/ui/button';
import { sendETHPayment, sendUSDCPayment } from '@/lib/blockchain';
import { hasSufficientBalance, refreshWalletBalances, validateActiveGameSession } from '@/lib/session-access';
import { ArrowLeft, Trophy, Lock, Keyboard, Zap, Flame } from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import type { Address } from 'viem';
import baseplayLogo from '@/assets/baseplay-logo.png';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const GAME_FEE_USDC = '0.49';
const CREATOR_FEE_ETH = '0.0001';

const CREATOR_WALLETS = [
  '0xadf983e3d07d6abf344e1923f1d2164d8dffd816',
  '0xf79f164e634b76815b80b60a85e1258eb21d631c',
].map(addr => addr.toLowerCase());

const isCreatorWallet = (address: string | null) =>
  address && CREATOR_WALLETS.includes(address.toLowerCase());

type SessionStatus = 'checking' | 'locked' | 'active';

const PlayTyping = () => {
  const {
    phase, countdown, timeLeft, currentWord, input, wpm, accuracy,
    finalScore, streak, bestStreak, correctWords, totalAttempts, wordMode,
    startGame, handleInput, resetGame, getInputStatus,
  } = useTypingGame();

  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const submittedRef = useRef(false);

  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showPayment, setShowPayment] = useState(false);
  const [balanceETH, setBalanceETH] = useState('0');
  const [balanceUSDC, setBalanceUSDC] = useState('0');
  const [isProcessing, setIsProcessing] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('locked');
  const [dynamicEthFee, setDynamicEthFee] = useState<string | null>(null);
  const [ethPriceUsd, setEthPriceUsd] = useState<number | null>(null);
  const [scoreSaved, setScoreSaved] = useState(false);
  const [selectedMode, setSelectedMode] = useState<WordMode>('normal');

  const isCreator = isCreatorWallet(walletAddress);
  const hasActiveSession = sessionStatus === 'active';
  const isCheckingSession = sessionStatus === 'checking';

  useEffect(() => {
    const fetchEthFee = async () => {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/eth-price`);
        if (res.ok) {
          const data = await res.json();
          if (data.fee_eth) { setDynamicEthFee(data.fee_eth); setEthPriceUsd(data.eth_price_usd ?? null); }
        }
      } catch { setDynamicEthFee('0.00040000'); }
    };
    fetchEthFee();
  }, []);

  // Focus input when playing
  useEffect(() => {
    if (phase === 'playing') inputRef.current?.focus();
  }, [phase, currentWord]);

  const handleBalanceUpdate = useCallback((ethBal: string, usdcBal: string) => {
    setBalanceETH(ethBal); setBalanceUSDC(usdcBal);
  }, []);

  const syncBalances = useCallback(async (address: string) => {
    const balances = await refreshWalletBalances(address);
    setBalanceETH(balances.ethBalance); setBalanceUSDC(balances.usdcBalance);
    return balances;
  }, []);

  const validateSession = useCallback(async (address: string) => {
    setSessionStatus('checking');
    try {
      const result = await validateActiveGameSession(address, 'typing');
      if (result.valid && result.session_id) {
        setSessionId(result.session_id); setSessionStatus('active'); return result;
      }
      setSessionId(null); setSessionStatus('locked'); return result;
    } catch {
      setSessionId(null); setSessionStatus('locked');
      return { valid: false, session_id: null, player_id: null, reason: null };
    }
  }, []);

  const handleWalletConnect = useCallback(async (address: string) => {
    setWalletAddress(address);
    await Promise.all([syncBalances(address), validateSession(address)]);
  }, [syncBalances, validateSession]);

  const handleWalletDisconnect = useCallback(() => {
    setWalletAddress(null); setSessionId(null);
    setBalanceETH('0'); setBalanceUSDC('0'); setSessionStatus('locked');
  }, []);

  useEffect(() => {
    if (!showPayment || !walletAddress) return;
    syncBalances(walletAddress).catch(console.error);
  }, [showPayment, walletAddress, syncBalances]);

  const startNewGame = useCallback(async (token: PaymentToken) => {
    if (!walletAddress) { toast.error('Please connect your wallet first'); return; }
    setIsProcessing(true);
    try {
      const isCreatorPayment = isCreator;
      const feeAmount = isCreatorPayment ? CREATOR_FEE_ETH : token === 'ETH' ? dynamicEthFee ?? '0.00040000' : GAME_FEE_USDC;
      const paymentToken = isCreatorPayment ? 'ETH' : token;
      const balances = await syncBalances(walletAddress);
      const validationResult = hasSufficientBalance(paymentToken, feeAmount, balances);

      if (!validationResult) { toast.error('Insufficient balance to start a new session'); return; }

      toast.info(isCreatorPayment
        ? `Creator verification: Sending ${feeAmount} ETH...`
        : `Sending ${feeAmount} ${paymentToken}... Please confirm in your wallet.`
      );

      let txHash: string;
      if (paymentToken === 'ETH') { txHash = await sendETHPayment(walletAddress as Address, feeAmount); }
      else { txHash = await sendUSDCPayment(walletAddress as Address, feeAmount); }

      toast.info('Payment confirmed! Creating game session...');

      const response = await fetch(`${SUPABASE_URL}/functions/v1/create-game-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: walletAddress, tx_hash: txHash, token_type: paymentToken,
          fee_amount: feeAmount, is_creator: isCreatorPayment, game_type: 'typing',
        }),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Failed to create game session');

      setSessionId(result.session_id); setSessionStatus('active'); setScoreSaved(false);
      resetGame(); setShowPayment(false);
      toast.success(isCreatorPayment ? 'Creator verified! Game started!' : 'Game started! Good luck!');
    } catch (error: any) {
      const msg = String(error?.message || '').toLowerCase();
      if (msg.includes('rejected') || msg.includes('denied')) toast.error('Transaction cancelled');
      else toast.error(error.message || 'Failed to process payment');
    } finally { setIsProcessing(false); }
  }, [walletAddress, isCreator, dynamicEthFee, resetGame, syncBalances]);

  const handlePlayAgain = useCallback(() => {
    setScoreSaved(false); submittedRef.current = false;
    setSessionStatus('locked'); setSessionId(null);
    resetGame();
    if (walletAddress) setShowPayment(true);
  }, [walletAddress, resetGame]);

  // End game session when game finishes (wait for finalScore to be computed)
  useEffect(() => {
    if (phase !== 'finished' || !sessionId || !walletAddress || submittedRef.current) return;
    // If the player attempted any words, wait for finalScore to be computed by the hook
    // (the hook's score effect runs after this one on the same render).
    if (totalAttempts > 0 && finalScore <= 0) {
      console.info('[typing] waiting for finalScore to compute', { totalAttempts, finalScore });
      return;
    }
    submittedRef.current = true;
    const payload = {
      session_id: sessionId,
      wallet_address: walletAddress,
      score: finalScore,
      wpm, accuracy, best_streak: bestStreak,
      end_game: true,
    };
    console.info('[typing] submitting score', { ...payload, correctWords, totalAttempts, game_type: 'typing' });

    (async () => {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/update-game-score`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        console.info('[typing] save result', { status: res.status, ok: res.ok, data });
        if (res.ok && data?.success) {
          setScoreSaved(true);
          setSessionStatus('locked');
          toast.success('Score saved to leaderboard');
          queryClient.invalidateQueries({ queryKey: ['leaderboard'] });
        } else {
          submittedRef.current = false;
          const reason = data?.error || `HTTP ${res.status}`;
          console.error('Speed Typing Save Error:', reason, data);
          toast.error(`Failed to save leaderboard score: ${reason}`);
        }
      } catch (e: any) {
        submittedRef.current = false;
        console.error('Speed Typing Save Error:', e);
        toast.error('Failed to save leaderboard score');
      }
    })();
  }, [phase, sessionId, walletAddress, finalScore, wpm, accuracy, bestStreak, correctWords, totalAttempts, queryClient]);

  const needsWalletConnection = !walletAddress;
  const needsPayment = walletAddress && sessionStatus === 'locked';
  const isPlayBlocked = needsWalletConnection || isCheckingSession || !!needsPayment;
  const inputStatus = getInputStatus();

  const timerPercent = (timeLeft / 120) * 100;
  const timerDisplay = `${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, '0')}`;

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/20 via-background to-secondary/30">
      <header className="py-4 px-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" />
            <img src={baseplayLogo} alt="BasePlay" className="h-8 w-8" width={32} height={32} />
          </Link>
          <h1 className="text-2xl font-black gradient-title flex items-center gap-2">
            <Keyboard className="h-5 w-5" /> Speed Typing
          </h1>
          <div className="flex items-center gap-2">
            <Link to="/leaderboard/typing">
              <Button variant="ghost" size="sm"><Trophy className="h-4 w-4" /></Button>
            </Link>
            <WalletConnect onConnect={handleWalletConnect} onDisconnect={handleWalletDisconnect} onBalanceUpdate={handleBalanceUpdate} />
          </div>
        </div>
      </header>

      <main className="px-4 pb-8">
        <div className="max-w-lg mx-auto space-y-4">
          {/* Stats bar */}
          <div className="grid grid-cols-4 gap-2">
            <div className="bg-card rounded-lg p-3 border border-border text-center">
              <p className="text-xs text-muted-foreground">WPM</p>
              <p className="text-xl font-bold text-primary">{wpm}</p>
            </div>
            <div className="bg-card rounded-lg p-3 border border-border text-center">
              <p className="text-xs text-muted-foreground">Accuracy</p>
              <p className="text-xl font-bold text-green-400">{accuracy}%</p>
            </div>
            <div className="bg-card rounded-lg p-3 border border-border text-center">
              <p className="text-xs text-muted-foreground flex items-center justify-center gap-1"><Flame className="h-3 w-3" />Streak</p>
              <p className="text-xl font-bold text-orange-400">{streak}</p>
            </div>
            <div className="bg-card rounded-lg p-3 border border-border text-center">
              <p className="text-xs text-muted-foreground">Time</p>
              <p className={`text-xl font-bold ${timeLeft <= 10 ? 'text-red-400 animate-pulse' : 'text-foreground'}`}>{timerDisplay}</p>
            </div>
          </div>

          {/* Timer bar */}
          {phase === 'playing' && (
            <div className="w-full h-1.5 bg-secondary rounded-full overflow-hidden">
              <motion.div
                className="h-full bg-primary rounded-full"
                initial={{ width: '100%' }}
                animate={{ width: `${timerPercent}%` }}
                transition={{ duration: 0.5 }}
              />
            </div>
          )}

          {/* Game area */}
          <div className="relative bg-card rounded-2xl border border-border p-6 min-h-[280px] flex flex-col items-center justify-center">
            {/* Session lock overlay */}
            {isPlayBlocked && phase === 'idle' && (
              <div className="absolute inset-0 bg-background/60 backdrop-blur-[2px] z-10 flex flex-col items-center justify-center rounded-2xl">
                <Lock className="h-12 w-12 text-primary mb-4" />
                {isCheckingSession ? (
                  <>
                    <p className="text-lg font-semibold mb-2">Checking Session</p>
                    <p className="text-sm text-muted-foreground">Validating your latest paid session...</p>
                  </>
                ) : needsWalletConnection ? (
                  <>
                    <p className="text-lg font-semibold mb-2">Connect Wallet to Play</p>
                    <WalletConnect onConnect={handleWalletConnect} onDisconnect={handleWalletDisconnect} onBalanceUpdate={handleBalanceUpdate} />
                  </>
                ) : (
                  <>
                    <p className="text-lg font-semibold mb-2">New Session Required</p>
                    <p className="text-sm text-muted-foreground mb-4">You need to start a new session to play</p>
                    <Button onClick={() => setShowPayment(true)} className="gradient-gold text-accent-foreground">Pay Entry Fee</Button>
                  </>
                )}
              </div>
            )}

            {/* Idle / Start */}
            {phase === 'idle' && !isPlayBlocked && (
              <div className="text-center space-y-4">
                <Keyboard className="h-16 w-16 text-primary mx-auto" />
                <h2 className="text-2xl font-bold">Speed Typing Arena</h2>
                <p className="text-muted-foreground text-sm">Type as fast as you can in 2 minutes!</p>
                <div className="flex gap-2 justify-center">
                  <Button
                    variant={selectedMode === 'normal' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSelectedMode('normal')}
                  >
                    Normal Mode
                  </Button>
                  <Button
                    variant={selectedMode === 'crypto' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSelectedMode('crypto')}
                  >
                    Crypto Mode
                  </Button>
                </div>
                <Button
                  onClick={() => startGame(selectedMode)}
                  className="gradient-primary text-primary-foreground glow-primary hover:opacity-90 text-lg px-8 py-3"
                >
                  <Zap className="mr-2 h-5 w-5" /> Start Game
                </Button>
              </div>
            )}

            {/* Countdown */}
            <AnimatePresence>
              {phase === 'countdown' && (
                <motion.div
                  key="countdown"
                  initial={{ scale: 0.5, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 1.5, opacity: 0 }}
                  className="text-center"
                >
                  <p className="text-muted-foreground mb-2">Get Ready...</p>
                  <motion.p
                    key={countdown}
                    initial={{ scale: 0.5, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 2, opacity: 0 }}
                    className="text-8xl font-black gradient-title"
                  >
                    {countdown}
                  </motion.p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Playing */}
            {phase === 'playing' && (
              <div className="w-full text-center space-y-6">
                <AnimatePresence mode="wait">
                  <motion.p
                    key={currentWord}
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: -20, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="text-4xl md:text-5xl font-black tracking-wide select-none"
                  >
                    {currentWord}
                  </motion.p>
                </AnimatePresence>

                <div className="relative max-w-sm mx-auto">
                  <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(e) => handleInput(e.target.value)}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className={`w-full text-center text-2xl font-mono py-3 px-4 rounded-xl border-2 bg-background outline-none transition-colors ${
                      inputStatus === 'correct'
                        ? 'border-green-500 text-green-400'
                        : inputStatus === 'incorrect'
                        ? 'border-red-500 text-red-400'
                        : 'border-border text-foreground'
                    }`}
                    placeholder="Type here..."
                  />
                </div>

                {streak >= 3 && (
                  <motion.p
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="text-orange-400 font-bold flex items-center justify-center gap-1"
                  >
                    <Flame className="h-4 w-4" /> {streak} word streak!
                  </motion.p>
                )}
              </div>
            )}

            {/* Results */}
            {phase === 'finished' && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-full text-center space-y-5"
              >
                <Trophy className="h-12 w-12 text-accent mx-auto" />
                <h2 className="text-2xl font-bold">Game Over!</h2>

                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-secondary/50 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground">WPM</p>
                    <p className="text-2xl font-bold text-primary">{wpm}</p>
                  </div>
                  <div className="bg-secondary/50 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground">Accuracy</p>
                    <p className="text-2xl font-bold text-green-400">{accuracy}%</p>
                  </div>
                  <div className="bg-secondary/50 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground">Score</p>
                    <p className="text-2xl font-bold gradient-title">{finalScore}</p>
                  </div>
                </div>

                <div className="flex gap-3 text-sm text-muted-foreground justify-center">
                  <span>{correctWords}/{totalAttempts} correct</span>
                  <span>•</span>
                  <span>Best streak: {bestStreak}</span>
                </div>

                <div className="flex flex-col gap-2 items-center">
                  {scoreSaved && <p className="text-sm font-medium text-green-500">Score saved to leaderboard.</p>}
                  <Button onClick={handlePlayAgain} className="gradient-primary text-primary-foreground glow-primary hover:opacity-90">
                    Play Again
                  </Button>
                </div>
              </motion.div>
            )}
          </div>

          <p className="text-center text-muted-foreground text-sm">
            {wordMode === 'crypto' ? '🔗 Crypto Mode — Web3 & Base vocabulary' : '⌨️ Normal Mode — Mixed word categories'}
          </p>
        </div>
      </main>

      <PaymentModal
        isOpen={showPayment} onClose={() => setShowPayment(false)} onPay={startNewGame}
        feeETH={isCreator ? CREATOR_FEE_ETH : dynamicEthFee ?? '0.00040000'} feeUSDC={GAME_FEE_USDC}
        balanceETH={balanceETH} balanceUSDC={balanceUSDC} isLoading={isProcessing}
        isCreator={isCreator} ethPriceUsd={ethPriceUsd ?? undefined}
      />
    </div>
  );
};

export default PlayTyping;

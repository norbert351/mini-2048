import { useState, useCallback, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTetris } from '@/hooks/useTetris';
import { TetrisBoard } from '@/components/game/TetrisBoard';
import { ScoreBox } from '@/components/game/ScoreBox';
import { WalletConnect } from '@/components/game/WalletConnect';
import { GameOverModal } from '@/components/game/GameOverModal';
import { PaymentModal, PaymentToken } from '@/components/game/PaymentModal';
import { ExitGameModal } from '@/components/game/ExitGameModal';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { sendETHPayment, sendUSDCPayment } from '@/lib/blockchain';
import { hasSufficientBalance, refreshWalletBalances, validateActiveGameSession } from '@/lib/session-access';
import { RotateCcw, Lock, ArrowLeft, Trophy, Pause, Play, ChevronsDown, ArrowDown } from 'lucide-react';
import { toast } from 'sonner';
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

const PlayTetris = () => {
  const { board, score, level, lines, gameOver, isPaused, softDropping, moveDown, moveHorizontal, rotatePiece, hardDrop, resetGame, togglePause, setSoftDropping, setFrozen } = useTetris();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const submittedRef = useRef(false);

  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showPayment, setShowPayment] = useState(false);
  const [balanceETH, setBalanceETH] = useState('0');
  const [balanceUSDC, setBalanceUSDC] = useState('0');
  const [isProcessing, setIsProcessing] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('locked');
  const [dynamicEthFee, setDynamicEthFee] = useState<string | null>(null);
  const [ethPriceUsd, setEthPriceUsd] = useState<number | null>(null);
  const [scoreSaved, setScoreSaved] = useState(false);
  const [showExitModal, setShowExitModal] = useState(false);

  const isCreator = isCreatorWallet(walletAddress);
  const hasActiveSession = sessionStatus === 'active';
  const isCheckingSession = sessionStatus === 'checking';
  const isGameActive = hasActiveSession && !gameOver && sessionId;

  // Keep board frozen until paid
  useEffect(() => {
    setFrozen(!hasActiveSession);
  }, [hasActiveSession, setFrozen]);

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

  const handleBalanceUpdate = useCallback((ethBal: string, usdcBal: string) => { setBalanceETH(ethBal); setBalanceUSDC(usdcBal); }, []);

  const syncBalances = useCallback(async (address: string) => {
    const balances = await refreshWalletBalances(address);
    setBalanceETH(balances.ethBalance);
    setBalanceUSDC(balances.usdcBalance);
    return balances;
  }, []);

  const validateSession = useCallback(async (address: string) => {
    setSessionStatus('checking');
    try {
      const result = await validateActiveGameSession(address, 'tetris');
      console.info('[Tetris] session validation', { walletAddress: address, sessionId: result.session_id, valid: result.valid });

      if (result.valid && result.session_id) {
        setSessionId(result.session_id);
        if (result.player_id) setPlayerId(result.player_id);
        setSessionStatus('active');
        return result;
      }
      setSessionId(null);
      setSessionStatus('locked');
      return result;
    } catch (error) {
      console.error('[Tetris] session validation failed', error);
      setSessionId(null);
      setSessionStatus('locked');
      return { valid: false, session_id: null, player_id: null, reason: null };
    }
  }, []);

  const handleWalletConnect = useCallback(async (address: string) => {
    setWalletAddress(address);
    const [, validationResult] = await Promise.all([syncBalances(address), validateSession(address)]);
    // Also grab player ID from DB
    const { data } = await supabase.from('players').select('id').eq('wallet_address', address.toLowerCase()).single();
    if (data) setPlayerId(data.id);
  }, [syncBalances, validateSession]);

  const handleWalletDisconnect = useCallback(() => {
    setWalletAddress(null); setPlayerId(null); setSessionId(null);
    setBalanceETH('0'); setBalanceUSDC('0'); setSessionStatus('locked');
  }, []);

  // Refresh balances when payment modal opens
  useEffect(() => {
    if (!showPayment || !walletAddress) return;
    syncBalances(walletAddress).catch(console.error);
  }, [showPayment, walletAddress, syncBalances]);

  // Safety: never leave the UI stuck in "processing" once the modal closes.
  useEffect(() => {
    if (!showPayment) setIsProcessing(false);
  }, [showPayment]);

  const startNewGame = useCallback(async (token: PaymentToken) => {
    if (!walletAddress) { toast.error('Connect wallet first'); return; }
    setIsProcessing(true);
    try {
      const isCreatorPayment = isCreator;
      const feeAmount = isCreatorPayment ? CREATOR_FEE_ETH : token === 'ETH' ? dynamicEthFee ?? '0.00040000' : GAME_FEE_USDC;
      const paymentToken = isCreatorPayment ? 'ETH' : token;

      // Pre-play balance check
      const balances = await syncBalances(walletAddress);
      const sufficient = hasSufficientBalance(paymentToken, feeAmount, balances);
      console.info('[Tetris] pre-play balance check', { walletAddress, token: paymentToken, balance: paymentToken === 'ETH' ? balances.ethBalance : balances.usdcBalance, requiredFee: feeAmount, sufficient });

      if (!sufficient) {
        toast.error('Insufficient balance to start a new session');
        return;
      }

      toast.info(isCreatorPayment
        ? `Creator verification: Sending ${feeAmount} ETH...`
        : `Sending ${feeAmount} ${paymentToken}... Please confirm in your wallet.`
      );

      let txHash: string;
      if (paymentToken === 'ETH') txHash = await sendETHPayment(walletAddress as Address, feeAmount);
      else txHash = await sendUSDCPayment(walletAddress as Address, feeAmount);

      toast.info('Payment confirmed! Creating game session...');

      const response = await fetch(`${SUPABASE_URL}/functions/v1/create-game-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: walletAddress, tx_hash: txHash, token_type: paymentToken, fee_amount: feeAmount, is_creator: isCreatorPayment, game_type: 'tetris' }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);

      setSessionId(result.session_id); setPlayerId(result.player_id);
      setSessionStatus('active'); setScoreSaved(false); resetGame(); setShowPayment(false);
      console.info('[Tetris] session unlocked after payment', { walletAddress, txHash, sessionId: result.session_id });
      toast.success('Game started!');
    } catch (error: any) {
      const msg = String(error?.message || '').toLowerCase();
      if (msg.includes('rejected') || msg.includes('denied') || msg.includes('not authorized')) {
        toast.error('Transaction cancelled');
      } else {
        toast.error(error.message || 'Payment failed');
      }
    } finally { setIsProcessing(false); }
  }, [walletAddress, isCreator, dynamicEthFee, resetGame, syncBalances]);

  const handlePlayAgain = useCallback(() => {
    setScoreSaved(false);
    submittedRef.current = false;
    setSessionStatus('locked');
    setSessionId(null);
    if (walletAddress) setShowPayment(true);
    else resetGame();
  }, [walletAddress, resetGame]);

  const submitFinalScore = useCallback(async () => {
    if (!sessionId || !walletAddress || submittedRef.current) return;
    submittedRef.current = true;
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/update-game-score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, wallet_address: walletAddress, score, end_game: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setScoreSaved(true);
        toast.success('Score saved to leaderboard');
        queryClient.invalidateQueries({ queryKey: ['leaderboard'] });
      } else {
        submittedRef.current = false;
        toast.error(data?.error || 'Failed to save score');
      }
    } catch (e) {
      submittedRef.current = false;
      console.error(e);
      toast.error('Failed to save score');
    }
  }, [sessionId, walletAddress, score, queryClient]);

  const endSession = useCallback(async () => {
    await submitFinalScore();
    setSessionStatus('locked');
    setSessionId(null);
  }, [submitFinalScore]);

  // Auto end session on game over
  useEffect(() => {
    if (gameOver && sessionId && walletAddress && !submittedRef.current) {
      submitFinalScore().then(() => setSessionStatus('locked'));
    }
  }, [gameOver, sessionId, walletAddress, submitFinalScore]);

  // Handle back button click
  const handleBackClick = useCallback((e: React.MouseEvent) => {
    if (isGameActive) {
      e.preventDefault();
      togglePause();
      setShowExitModal(true);
    }
  }, [isGameActive, togglePause]);

  const handleExitCancel = useCallback(() => {
    setShowExitModal(false);
    if (isPaused) togglePause();
  }, [isPaused, togglePause]);

  const handleExit = useCallback(async () => {
    await endSession();
    setShowExitModal(false);
    toast.success('Score saved!');
    navigate('/');
  }, [endSession, navigate]);

  // Browser beforeunload
  useEffect(() => {
    if (!isGameActive) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isGameActive]);

  const needsWalletConnection = !walletAddress;
  const needsPayment = walletAddress && sessionStatus === 'locked';
  const isPlayBlocked = needsWalletConnection || isCheckingSession || !!needsPayment;
  const showControls = walletAddress && hasActiveSession && !gameOver;

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-500/20 via-background to-secondary/30">
      <header className="py-3 px-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link to="/" onClick={handleBackClick} className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" />
            <img src={baseplayLogo} alt="BasePlay" className="h-7 w-7" width={28} height={28} />
          </Link>
          <h1 className="text-2xl font-black" style={{ background: 'linear-gradient(135deg, hsl(280,65%,55%), hsl(330,80%,55%))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Tetris</h1>
          <div className="flex items-center gap-1">
            <Link to="/leaderboard/tetris"><Button variant="ghost" size="sm"><Trophy className="h-4 w-4" /></Button></Link>
            <WalletConnect onConnect={handleWalletConnect} onDisconnect={handleWalletDisconnect} onBalanceUpdate={handleBalanceUpdate} />
          </div>
        </div>
      </header>

      <main className="px-3 pb-3">
        <div className="max-w-sm mx-auto space-y-2">
          <div className="flex items-center justify-between gap-2">
            <ScoreBox label="Score" score={score} />
            <ScoreBox label="Level" score={level} />
            <ScoreBox label="Lines" score={lines} />
          </div>

          <div className="flex justify-center gap-2">
            {showControls && (
              <Button variant="outline" size="sm" onClick={togglePause}>
                {isPaused ? <Play className="h-4 w-4 mr-1" /> : <Pause className="h-4 w-4 mr-1" />}
                {isPaused ? 'Resume' : 'Pause'}
              </Button>
            )}
            {walletAddress && hasActiveSession && (
              <Button variant="outline" size="sm" onClick={() => setShowPayment(true)} className="gradient-primary text-primary-foreground border-none">
                <RotateCcw className="mr-1 h-4 w-4" /> New Game
              </Button>
            )}
          </div>

          <div className="relative">
            {isPlayBlocked && (
              <div className="absolute inset-0 bg-background/60 backdrop-blur-[2px] z-10 flex flex-col items-center justify-center rounded-xl">
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
                    <Button onClick={() => setShowPayment(true)} className="gradient-gold text-accent-foreground">Pay $0.49</Button>
                  </>
                )}
              </div>
            )}
            <TetrisBoard board={board} disabled={!!isPlayBlocked}
              onMoveLeft={() => moveHorizontal(-1)} onMoveRight={() => moveHorizontal(1)}
              onMoveDown={moveDown} onRotate={rotatePiece} onHardDrop={hardDrop}
            />
          </div>

          {showControls && (
            <div className="flex items-center justify-center gap-3">
              <Button variant="outline" size="sm" className="flex-1 max-w-[140px]" onClick={hardDrop}>
                <ChevronsDown className="h-4 w-4 mr-1" /> Hard Drop
              </Button>
              <Button
                variant={softDropping ? "default" : "outline"}
                size="sm"
                className={`flex-1 max-w-[140px] ${softDropping ? 'gradient-primary text-primary-foreground border-none' : ''}`}
                onClick={() => setSoftDropping(!softDropping)}
              >
                <ArrowDown className="h-4 w-4 mr-1" /> {softDropping ? 'Fast ●' : 'Speed Up'}
              </Button>
            </div>
          )}

          <p className="text-center text-muted-foreground text-xs">
            Tap to rotate • Swipe to move • Swipe down to drop
          </p>
        </div>
      </main>

      <GameOverModal isOpen={gameOver} score={score} won={false} onPlayAgain={handlePlayAgain} onClose={handlePlayAgain} scoreSaved={scoreSaved} lines={lines} level={level} />
      <PaymentModal isOpen={showPayment} onClose={() => setShowPayment(false)} onPay={startNewGame}
        feeETH={isCreator ? CREATOR_FEE_ETH : dynamicEthFee ?? '0.00040000'} feeUSDC={GAME_FEE_USDC}
        balanceETH={balanceETH} balanceUSDC={balanceUSDC} isLoading={isProcessing}
        isCreator={isCreator} ethPriceUsd={ethPriceUsd ?? undefined}
      />
      <ExitGameModal
        isOpen={showExitModal}
        score={score}
        onCancel={handleExitCancel}
        onExit={handleExit}
      />
    </div>
  );
};

export default PlayTetris;

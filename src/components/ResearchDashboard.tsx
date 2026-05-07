import React, { useState, useEffect } from 'react';
import { Upload, FileText, X, Loader2, Search, BarChart3, ShieldCheck, MessageSquare, Save, History, LogIn, LogOut, Plus, Trash2, Copy, Check, Clock, Brain, Layers, ListTodo, ChevronRight, ChevronDown, Square, CheckSquare, Edit2, PlusCircle, GripVertical, Terminal, Code, Bell, AlertCircle, Calendar } from 'lucide-react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/src/components/ui/card';
import { ScrollArea } from '@/src/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/src/components/ui/tabs';
import { Badge } from '@/src/components/ui/badge';
import { Separator } from '@/src/components/ui/separator';
import { Input } from '@/src/components/ui/input';
import { Skeleton } from '@/src/components/ui/skeleton';
import { motion, AnimatePresence } from 'motion/react';
import { pdfToImages, fileToBase64 } from '@/src/lib/pdf-helper';
import { analyzeDocuments, ResearchResult, chatWithDocuments } from '@/src/lib/gemini';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import ReactMarkdown from 'react-markdown';
import { auth, db, googleProvider, signInWithPopup, signOut, onAuthStateChanged, User, handleFirestoreError, OperationType } from '@/src/lib/firebase';
import { collection, query, where, onSnapshot, doc, setDoc, deleteDoc, serverTimestamp, writeBatch, getDocs, orderBy } from 'firebase/firestore';

export default function ResearchDashboard() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [sessions, setSessions] = useState<any[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState('Untitled Research');

  const [files, setFiles] = useState<{ id: string; name: string; type: string; data: string; page?: number }[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [activeTab, setActiveTab] = useState('analysis');
  
  // Chat state
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'model'; text: string }[]>([]);
  const [isChatting, setIsChatting] = useState(false);
  const [copied, setCopied] = useState(false);

  // Task state
  const [tasks, setTasks] = useState<any[]>([]);
  const [newTaskText, setNewTaskText] = useState('');

  // Data Editor state
  const [newDataLabel, setNewDataLabel] = useState('');
  const [newDataValue, setNewDataValue] = useState('');
  const [editingDataIndex, setEditingDataIndex] = useState<number | null>(null);
  const [notifications, setNotifications] = useState<{ id: string; text: string; type: 'warning' | 'error' }[]>([]);

  const getDeadlineStatus = (deadline?: string) => {
    if (!deadline) return 'none';
    const now = new Date();
    const deadlineDate = new Date(deadline);
    const diff = deadlineDate.getTime() - now.getTime();
    const hours = diff / (1000 * 60 * 60);

    if (diff < 0) return 'overdue';
    if (hours <= 24) return 'approaching';
    return 'future';
  };

  useEffect(() => {
    const checkDeadlines = () => {
      const newNotifications: { id: string; text: string; type: 'warning' | 'error' }[] = [];
      const traverse = (items: any[]) => {
        items.forEach(task => {
          if (!task.completed && task.deadline) {
            const status = getDeadlineStatus(task.deadline);
            if (status === 'overdue') {
              newNotifications.push({ id: task.id, text: `Overdue: ${task.text}`, type: 'error' });
            } else if (status === 'approaching') {
              newNotifications.push({ id: task.id, text: `Approaching Deadline: ${task.text}`, type: 'warning' });
            }
          }
          if (task.subtasks.length > 0) traverse(task.subtasks);
        });
      };
      traverse(tasks);
      setNotifications(newNotifications);
    };

    checkDeadlines();
    const interval = setInterval(checkDeadlines, 60000); // Check every minute
    return () => clearInterval(interval);
  }, [tasks]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Sessions Listener
  useEffect(() => {
    if (!user) {
      setSessions([]);
      return;
    }

    const q = query(collection(db, 'sessions'), where('userId', '==', user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      setSessions(docs);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'sessions');
    });

    return () => unsubscribe();
  }, [user]);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error(error);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      resetSession();
    } catch (error) {
      console.error(error);
    }
  };

  const resetSession = () => {
    setFiles([]);
    setResult(null);
    setChatMessages([]);
    setTasks([]);
    setCurrentSessionId(null);
    setSessionName('Untitled Research');
    setActiveTab('analysis');
  };

  const saveSession = async () => {
    if (!user) return;
    
    const sessionId = currentSessionId || crypto.randomUUID();
    const sessionData = {
      id: sessionId,
      name: sessionName,
      userId: user.uid,
      result,
      createdAt: currentSessionId ? sessions.find(s => s.id === sessionId)?.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    try {
      const batch = writeBatch(db);
      
      // Save main session metadata
      batch.set(doc(db, 'sessions', sessionId), sessionData);

      // Save files to subcollection
      for (const file of files) {
        batch.set(doc(db, 'sessions', sessionId, 'files', file.id), file);
      }

      // Save chat messages to subcollection
      chatMessages.forEach((msg, i) => {
        const msgId = `msg-${i}`;
        batch.set(doc(db, 'sessions', sessionId, 'messages', msgId), {
          ...msg,
          timestamp: new Date().toISOString()
        });
      });

      // Save tasks to subcollection
      tasks.forEach((task) => {
        batch.set(doc(db, 'sessions', sessionId, 'tasks', task.id), task);
      });

      await batch.commit();
      setCurrentSessionId(sessionId);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `sessions/${sessionId}`);
    }
  };

  const loadSession = async (session: any) => {
    setCurrentSessionId(session.id);
    setSessionName(session.name);
    setResult(session.result || null);
    setActiveTab('analysis');

    try {
      // Load files from subcollection
      const filesSnap = await getDocs(collection(db, 'sessions', session.id, 'files'));
      setFiles(filesSnap.docs.map(d => d.data() as any));

      // Load chat messages from subcollection
      const messagesSnap = await getDocs(query(collection(db, 'sessions', session.id, 'messages'), orderBy('timestamp', 'asc')));
      setChatMessages(messagesSnap.docs.map(d => ({ role: d.data().role, text: d.data().text })));

      // Load tasks from subcollection
      const tasksSnap = await getDocs(collection(db, 'sessions', session.id, 'tasks'));
      setTasks(tasksSnap.docs.map(d => d.data() as any));
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `sessions/${session.id}`);
    }
  };

  const deleteSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await deleteDoc(doc(db, 'sessions', id));
      if (currentSessionId === id) resetSession();
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `sessions/${id}`);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = e.target.files;
    if (!uploadedFiles) return;

    const newFiles = [];
    for (const file of Array.from(uploadedFiles)) {
      if (file.type === 'application/pdf') {
        const images = await pdfToImages(file);
        newFiles.push(...images.map(img => ({
          id: `${file.name}-p${img.page}`,
          name: `${file.name} (Page ${img.page})`,
          type: 'image/jpeg',
          data: img.data,
          page: img.page
        })));
      } else if (file.type.startsWith('image/')) {
        const base64 = await fileToBase64(file);
        newFiles.push({
          id: file.name,
          name: file.name,
          type: file.type,
          data: base64
        });
      }
    }
    const updatedFiles = [...files, ...newFiles];
    setFiles(updatedFiles);
    
    // Auto-trigger analysis
    if (updatedFiles.length > 0) {
      runAnalysis(updatedFiles);
    }
  };

  const removeFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const runAnalysis = async (filesOverride?: typeof files) => {
    const targetFiles = filesOverride || files;
    if (targetFiles.length === 0) return;
    setIsAnalyzing(true);
    try {
      const geminiFiles = targetFiles.map(f => ({
        name: f.name,
        data: f.data,
        mimeType: f.type
      }));
      const res = await analyzeDocuments(geminiFiles, "Analyze these documents comprehensively. Identify key trends, extract data for visualization, and verify any major claims.");
      setResult(res);
      setActiveTab('analysis');
    } catch (error) {
      console.error(error);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleChat = async () => {
    if (!chatInput.trim() || isChatting) return;
    
    const userMsg = chatInput;
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setIsChatting(true);

    try {
      const geminiFiles = files.map(f => ({
        name: f.name,
        data: f.data,
        mimeType: f.type
      }));
      const response = await chatWithDocuments([], userMsg, geminiFiles);
      setChatMessages(prev => [...prev, { role: 'model', text: response || "I couldn't generate a response." }]);
    } catch (error) {
      console.error(error);
      setChatMessages(prev => [...prev, { role: 'model', text: "Error communicating with research assistant." }]);
    } finally {
      setIsChatting(false);
    }
  };

  // Task Management Functions
  const addTask = (parentId: string | null = null) => {
    if (!newTaskText.trim()) return;
    
    const newTask = {
      id: crypto.randomUUID(),
      text: newTaskText,
      completed: false,
      deadline: null,
      subtasks: []
    };

    if (parentId === null) {
      setTasks([...tasks, newTask]);
    } else {
      const updateTasks = (items: any[]): any[] => {
        return items.map(item => {
          if (item.id === parentId) {
            return { ...item, subtasks: [...item.subtasks, newTask] };
          }
          if (item.subtasks.length > 0) {
            return { ...item, subtasks: updateTasks(item.subtasks) };
          }
          return item;
        });
      };
      setTasks(updateTasks(tasks));
    }
    setNewTaskText('');
  };

  // Data Point Management
  const addDataPoint = () => {
    if (!newDataLabel.trim() || !newDataValue.trim() || !result) return;
    const newValue = parseFloat(newDataValue);
    if (isNaN(newValue)) return;

    const updatedDataPoints = [...(result.dataPoints || []), { label: newDataLabel, value: newValue }];
    setResult({ ...result, dataPoints: updatedDataPoints });
    setNewDataLabel('');
    setNewDataValue('');
  };

  const updateDataPoint = (index: number, label: string, value: string) => {
    if (!result) return;
    const newValue = parseFloat(value);
    if (isNaN(newValue)) return;

    const updatedDataPoints = [...result.dataPoints];
    updatedDataPoints[index] = { label, value: newValue };
    setResult({ ...result, dataPoints: updatedDataPoints });
  };

  const removeDataPoint = (index: number) => {
    if (!result) return;
    const updatedDataPoints = result.dataPoints.filter((_, i) => i !== index);
    setResult({ ...result, dataPoints: updatedDataPoints });
  };

  const generatePythonCode = () => {
    if (!result?.dataPoints) return "";
    const dataStr = JSON.stringify(result.dataPoints, null, 2);
    return `import plotly.graph_objects as go

def visualize_research_data(data_points):
    """
    Visualizes numerical data points extracted from the research corpus.
    """
    if not data_points:
        print("Error: Missing numerical data.")
        return

    labels = [dp['label'] for dp in data_points]
    values = [dp['value'] for dp in data_points]

    fig = go.Figure(data=[
        go.Bar(
            x=labels, 
            y=values,
            marker_color='#EA580C',
            opacity=0.9,
            hovertemplate='<b>%{x}</b><br>Value: %{y}<extra></extra>'
        )
    ])

    fig.update_layout(
        title={
            'text': "Extracted Research Trends",
            'y': 0.95,
            'x': 0.5,
            'xanchor': 'center',
            'yanchor': 'top',
            'font': {'size': 20}
        },
        xaxis_title="Category / Metric",
        yaxis_title="Value",
        template="plotly_white",
        font=dict(family="Inter, sans-serif", size=14, color="#1A1A1A"),
        margin=dict(l=60, r=60, t=100, b=60),
        plot_bgcolor='rgba(0,0,0,0)',
        paper_bgcolor='rgba(0,0,0,0)',
        xaxis=dict(showgrid=False),
        yaxis=dict(gridcolor='#F1F5F9')
    )

    fig.show()

# Data extracted from Aetheris Research Assistant
data_points = ${dataStr}

visualize_research_data(data_points)`;
  };

  const handleExportPython = () => {
    const code = generatePythonCode();
    copyToClipboard(code);
  };

  const toggleTask = (id: string) => {
    const updateTasks = (items: any[]): any[] => {
      return items.map(item => {
        if (item.id === id) {
          return { ...item, completed: !item.completed };
        }
        if (item.subtasks.length > 0) {
          return { ...item, subtasks: updateTasks(item.subtasks) };
        }
        return item;
      });
    };
    setTasks(updateTasks(tasks));
  };

  const removeTask = (id: string) => {
    const updateTasks = (items: any[]): any[] => {
      return items.filter(item => item.id !== id).map(item => ({
        ...item,
        subtasks: updateTasks(item.subtasks)
      }));
    };
    setTasks(updateTasks(tasks));
  };

  const updateTaskText = (id: string, newText: string) => {
    const updateTasks = (items: any[]): any[] => {
      return items.map(item => {
        if (item.id === id) {
          return { ...item, text: newText };
        }
        if (item.subtasks.length > 0) {
          return { ...item, subtasks: updateTasks(item.subtasks) };
        }
        return item;
      });
    };
    setTasks(updateTasks(tasks));
  };

  const onDragEnd = (result: DropResult) => {
    const { source, destination } = result;
    if (!destination) return;

    const reorder = (list: any[], startIndex: number, endIndex: number) => {
      const result = Array.from(list);
      const [removed] = result.splice(startIndex, 1);
      result.splice(endIndex, 0, removed);
      return result;
    };

    // Handle reordering at the same level
    if (source.droppableId === destination.droppableId) {
      if (source.droppableId === 'tasks-root') {
        const newTasks = reorder(tasks, source.index, destination.index);
        setTasks(newTasks);
      } else {
        const parentId = source.droppableId.replace('subtasks-', '');
        const updateTasks = (items: any[]): any[] => {
          return items.map(item => {
            if (item.id === parentId) {
              return { ...item, subtasks: reorder(item.subtasks, source.index, destination.index) };
            }
            if (item.subtasks.length > 0) {
              return { ...item, subtasks: updateTasks(item.subtasks) };
            }
            return item;
          });
        };
        setTasks(updateTasks(tasks));
      }
    }
  };

  const TaskItem = ({ task, depth = 0, index }: { task: any, depth?: number, index: number }) => {
    const [isExpanded, setIsExpanded] = useState(true);
    const [isAddingSubtask, setIsAddingSubtask] = useState(false);
    const [subtaskText, setSubtaskText] = useState('');
    const [isEditing, setIsEditing] = useState(false);
    const [editText, setEditText] = useState(task.text);
    const [isEditingDeadline, setIsEditingDeadline] = useState(false);

    const handleAddSubtask = () => {
      if (!subtaskText.trim()) return;
      const newTask = {
        id: crypto.randomUUID(),
        text: subtaskText,
        completed: false,
        deadline: null,
        subtasks: []
      };
      
      const updateTasks = (items: any[]): any[] => {
        return items.map(item => {
          if (item.id === task.id) {
            return { ...item, subtasks: [...item.subtasks, newTask] };
          }
          if (item.subtasks.length > 0) {
            return { ...item, subtasks: updateTasks(item.subtasks) };
          }
          return item;
        });
      };
      setTasks(updateTasks(tasks));
      setSubtaskText('');
      setIsAddingSubtask(false);
    };

    const handleUpdateText = () => {
      if (editText.trim() && editText !== task.text) {
        updateTaskText(task.id, editText);
      }
      setIsEditing(false);
    };

    const handleUpdateDeadline = (newDeadline: string) => {
      const updateTasks = (items: any[]): any[] => {
        return items.map(item => {
          if (item.id === task.id) {
            return { ...item, deadline: newDeadline || null };
          }
          if (item.subtasks.length > 0) {
            return { ...item, subtasks: updateTasks(item.subtasks) };
          }
          return item;
        });
      };
      setTasks(updateTasks(tasks));
      setIsEditingDeadline(false);
    };

    const deadlineStatus = getDeadlineStatus(task.deadline);

    return (
      <Draggable draggableId={task.id} index={index}>
        {(provided) => (
          <div 
            ref={provided.innerRef}
            {...provided.draggableProps}
            className="space-y-2"
          >
            <div 
              className="relative"
              style={{ marginLeft: `${depth * 24}px` }}
            >
              {depth > 0 && (
                <div 
                  className="absolute left-0 top-0 bottom-0 w-[1px] bg-gray-200" 
                  style={{ left: `-12px` }}
                />
              )}
              <motion.div 
                layout
                initial={false}
                animate={{ 
                  scale: task.completed ? 0.99 : 1,
                  opacity: task.completed ? 0.8 : 1,
                  x: task.completed ? 4 : 0
                }}
                className={`relative flex items-center gap-3 p-2 rounded-lg transition-all duration-200 group ${
                  task.completed 
                    ? 'bg-gray-50/80' 
                    : deadlineStatus === 'overdue'
                      ? 'bg-red-50 border border-red-200 shadow-sm hover:shadow-md'
                      : deadlineStatus === 'approaching'
                        ? 'bg-orange-50 border border-orange-200 shadow-sm hover:shadow-md'
                        : 'bg-white border border-gray-100 shadow-sm hover:shadow-md hover:border-orange-200'
                }`}
              >
                {depth > 0 && (
                  <div 
                    className="absolute -left-3 top-1/2 w-3 h-[1px] bg-gray-200" 
                    style={{ left: `-12px` }}
                  />
                )}
                
                <div {...provided.dragHandleProps} className="text-gray-300 hover:text-gray-500 cursor-grab active:cursor-grabbing">
                  <GripVertical className="w-4 h-4" />
                </div>

                <motion.button 
                  whileTap={{ scale: 0.8 }}
                  onClick={() => toggleTask(task.id)} 
                  className={`transition-colors ${task.completed ? 'text-green-600' : 'text-orange-600 hover:text-orange-700'}`}
                >
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={task.completed ? 'checked' : 'unchecked'}
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 0.5, opacity: 0 }}
                      transition={{ duration: 0.15 }}
                    >
                      {task.completed ? <CheckSquare className="w-5 h-5" /> : <Square className="w-5 h-5" />}
                    </motion.div>
                  </AnimatePresence>
                </motion.button>
                
                {isEditing ? (
                  <Input 
                    autoFocus
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={handleUpdateText}
                    onKeyDown={(e) => e.key === 'Enter' && handleUpdateText()}
                    className="h-7 text-sm flex-1 bg-white"
                  />
                ) : (
                  <motion.span 
                    layout
                    className={`text-sm flex-1 cursor-text transition-all duration-300 ${task.completed ? 'line-through text-gray-400 italic' : 'text-gray-700'}`}
                    onDoubleClick={() => setIsEditing(true)}
                  >
                    {task.text}
                    {task.deadline && !task.completed && (
                      <span className={`ml-3 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                        deadlineStatus === 'overdue' ? 'bg-red-100 text-red-700' : 
                        deadlineStatus === 'approaching' ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-600'
                      }`}>
                        Due: {new Date(task.deadline).toLocaleDateString()}
                      </span>
                    )}
                  </motion.span>
                )}

                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {isEditingDeadline ? (
                    <Input 
                      type="date"
                      autoFocus
                      className="h-7 w-32 text-[10px]"
                      onChange={(e) => handleUpdateDeadline(e.target.value)}
                      onBlur={() => setIsEditingDeadline(false)}
                    />
                  ) : (
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-orange-600" onClick={() => setIsEditingDeadline(true)}>
                      <Calendar className="w-3 h-3" />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-orange-600" onClick={() => setIsEditing(!isEditing)}>
                    <Edit2 className="w-3 h-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-orange-600" onClick={() => setIsAddingSubtask(!isAddingSubtask)}>
                    <Plus className="w-3 h-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-red-600" onClick={() => removeTask(task.id)}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                  {task.subtasks.length > 0 && (
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400" onClick={() => setIsExpanded(!isExpanded)}>
                      {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </Button>
                  )}
                </div>
              </motion.div>
            </div>

            {isAddingSubtask && (
              <div className="flex gap-2 mb-2" style={{ marginLeft: `${(depth + 1) * 24}px` }}>
                <Input 
                  value={subtaskText} 
                  onChange={(e) => setSubtaskText(e.target.value)}
                  placeholder="Add subtask..."
                  className="h-8 text-xs"
                  onKeyDown={(e) => e.key === 'Enter' && handleAddSubtask()}
                />
                <Button size="sm" className="h-8 bg-orange-600" onClick={handleAddSubtask}>Add</Button>
                <Button size="sm" variant="ghost" className="h-8" onClick={() => setIsAddingSubtask(false)}>Cancel</Button>
              </div>
            )}

            {isExpanded && (
              <Droppable droppableId={`subtasks-${task.id}`} type={`subtasks-${task.id}`}>
                {(provided) => (
                  <div 
                    {...provided.droppableProps}
                    ref={provided.innerRef}
                    className="space-y-2"
                  >
                    {task.subtasks.map((sub: any, i: number) => (
                      <TaskItem key={sub.id} task={sub} depth={depth + 1} index={i} />
                    ))}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            )}
          </div>
        )}
      </Draggable>
    );
  };

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans selection:bg-orange-100">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-orange-600 rounded-lg flex items-center justify-center">
              <ShieldCheck className="text-white w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight leading-none">Aetheris <span className="text-gray-400 font-normal">Research</span></h1>
              <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mt-1">Auditor-Grade Intelligence</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            {user ? (
              <div className="flex items-center gap-3">
                <div className="flex flex-col items-end">
                  <span className="text-xs font-medium text-gray-900">{user.displayName}</span>
                  <button onClick={handleLogout} className="text-[10px] text-gray-500 hover:text-orange-600 transition-colors">Sign Out</button>
                </div>
                {user.photoURL && <img src={user.photoURL} className="w-8 h-8 rounded-full border border-gray-200" referrerPolicy="no-referrer" />}
              </div>
            ) : (
              <Button onClick={handleLogin} variant="outline" size="sm" className="gap-2">
                <LogIn className="w-4 h-4" />
                Sign In
              </Button>
            )}
            <div className="h-8 w-[1px] bg-gray-200 mx-2" />
            <Badge variant="outline" className="bg-orange-50 text-orange-700 border-orange-200 font-medium">
              Multimodal v1.5
            </Badge>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-12 gap-8">
        {/* Left Sidebar: File Management & History */}
        <div className="col-span-12 lg:col-span-4 space-y-6">
          {user && (
            <Card className="border-gray-200 shadow-sm overflow-hidden">
              <CardHeader className="bg-gray-50/50 border-b border-gray-100 py-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <History className="w-4 h-4 text-orange-600" />
                    Saved Sessions
                  </CardTitle>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={resetSession}>
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-2">
                <ScrollArea className="h-[150px]">
                  {sessions.length === 0 ? (
                    <div className="p-4 text-center text-xs text-gray-400 italic">No saved sessions</div>
                  ) : (
                    sessions.map((s) => (
                      <div 
                        key={s.id} 
                        onClick={() => loadSession(s)}
                        className={`group flex items-center justify-between p-2 mb-1 rounded-md cursor-pointer transition-all duration-200 hover:shadow-sm ${
                          currentSessionId === s.id 
                            ? 'bg-orange-50 text-orange-700 border border-orange-100' 
                            : 'hover:bg-orange-50/50 border border-transparent hover:border-orange-100'
                        }`}
                      >
                        <div className="flex flex-col overflow-hidden">
                          <span className="text-xs font-medium truncate">{s.name}</span>
                          <span className="text-[10px] opacity-60">{new Date(s.updatedAt || s.createdAt).toLocaleDateString()}</span>
                        </div>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-red-600"
                          onClick={(e) => deleteSession(e, s.id)}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    ))
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          )}

          <Card className="border-gray-200 shadow-sm overflow-hidden">
            <CardHeader className="bg-gray-50/50 border-b border-gray-100">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Upload className="w-4 h-4 text-orange-600" />
                  Document Repository
                </CardTitle>
                {user && (
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-orange-600" onClick={saveSession}>
                    <Save className="w-4 h-4" />
                  </Button>
                )}
              </div>
              <div className="mt-2">
                <Input 
                  value={sessionName} 
                  onChange={(e) => setSessionName(e.target.value)}
                  className="h-7 text-xs bg-white border-gray-200"
                  placeholder="Session Name"
                />
              </div>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className="relative group">
                <input
                  type="file"
                  multiple
                  accept="application/pdf,image/*"
                  onChange={handleFileUpload}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                />
                <div className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center group-hover:border-orange-400 transition-colors bg-white">
                  <div className="w-12 h-12 bg-orange-50 rounded-full flex items-center justify-center mx-auto mb-3 group-hover:scale-110 transition-transform">
                    <Upload className="w-6 h-6 text-orange-600" />
                  </div>
                  <p className="text-sm font-medium text-gray-900">Drop files here</p>
                  <p className="text-xs text-gray-500 mt-1">PDF, PNG, JPG (Max 50 pages/file)</p>
                </div>
              </div>

              <ScrollArea className="h-[300px] pr-4">
                <AnimatePresence>
                  {files.map((file) => (
                    <motion.div
                      key={file.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      whileHover={{ scale: 1.01 }}
                      className="flex items-center justify-between p-3 mb-2 bg-white border border-gray-100 rounded-lg group hover:border-orange-200 hover:shadow-md hover:shadow-orange-500/5 transition-all duration-200"
                    >
                      <div className="flex items-center gap-3 overflow-hidden">
                        <div className="p-2 bg-gray-50 rounded">
                          <FileText className="w-4 h-4 text-gray-400" />
                        </div>
                        <div className="truncate">
                          <p className="text-xs font-medium text-gray-700 truncate">{file.name}</p>
                          <p className="text-[10px] text-gray-400 uppercase tracking-wider">{file.type.split('/')[1]}</p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => removeFile(file.id)}
                      >
                        <X className="w-3 h-3" />
                      </Button>
                    </motion.div>
                  ))}
                </AnimatePresence>
                {files.length === 0 && (
                  <div className="h-full flex flex-col items-center justify-center text-gray-400 py-12">
                    <FileText className="w-8 h-8 mb-2 opacity-20" />
                    <p className="text-xs">No documents uploaded</p>
                  </div>
                )}
              </ScrollArea>

              <Button 
                className="w-full bg-orange-600 hover:bg-orange-700 text-white shadow-lg shadow-orange-200"
                disabled={files.length === 0 || isAnalyzing}
                onClick={() => runAnalysis()}
              >
                {isAnalyzing ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Analyzing Multimodal Data...
                  </>
                ) : (
                  <>
                    <Search className="w-4 h-4 mr-2" />
                    Synthesize Research
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Right Content Area: Results & Interaction */}
        <div className="col-span-12 lg:col-span-8 space-y-6">
          {!result && !isAnalyzing ? (
            <div className="h-[600px] flex flex-col items-center justify-center text-center space-y-6 bg-white border border-gray-200 rounded-2xl border-dashed">
              <div className="w-20 h-20 bg-orange-50 rounded-3xl flex items-center justify-center">
                <BarChart3 className="w-10 h-10 text-orange-600" />
              </div>
              <div className="max-w-md">
                <h2 className="text-2xl font-semibold text-gray-900">Ready for Deep Analysis</h2>
                <p className="text-gray-500 mt-2">Upload your research papers, financial reports, or technical documents to begin the synthesis process.</p>
              </div>
            </div>
          ) : isAnalyzing ? (
            <div className="space-y-6">
              <Skeleton className="h-40 w-full rounded-2xl" />
              <div className="grid grid-cols-2 gap-6">
                <Skeleton className="h-60 w-full rounded-2xl" />
                <Skeleton className="h-60 w-full rounded-2xl" />
              </div>
              <Skeleton className="h-80 w-full rounded-2xl" />
            </div>
          ) : (
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
              <TabsList className="bg-white border border-gray-200 p-1 rounded-xl mb-6">
                <TabsTrigger value="analysis" className="rounded-lg data-[state=active]:bg-orange-50 data-[state=active]:text-orange-700">
                  <BarChart3 className="w-4 h-4 mr-2" />
                  Synthesis & Data
                </TabsTrigger>
                <TabsTrigger value="verification" className="rounded-lg data-[state=active]:bg-orange-50 data-[state=active]:text-orange-700">
                  <ShieldCheck className="w-4 h-4 mr-2" />
                  Fact Verification
                </TabsTrigger>
                <TabsTrigger value="chat" className="rounded-lg data-[state=active]:bg-orange-50 data-[state=active]:text-orange-700">
                  <MessageSquare className="w-4 h-4 mr-2" />
                  Research Chat
                </TabsTrigger>
                <TabsTrigger value="tasks" className="rounded-lg data-[state=active]:bg-orange-50 data-[state=active]:text-orange-700">
                  <ListTodo className="w-4 h-4 mr-2" />
                  Research Plan
                </TabsTrigger>
              </TabsList>

              <TabsContent value="analysis" className="space-y-6 mt-0">
                {result?.metrics && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="grid grid-cols-2 md:grid-cols-4 gap-4"
                  >
                    {[
                      { label: 'Total Pages', value: result.metrics.totalPages, icon: Layers, color: 'text-blue-600', bg: 'bg-blue-50' },
                      { label: 'Reading Time', value: result.metrics.readingTime, icon: Clock, color: 'text-orange-600', bg: 'bg-orange-50' },
                      { label: 'Sentiment', value: result.sentimentScore !== undefined ? `${result.sentimentScore}/10` : 'N/A', icon: Brain, color: 'text-purple-600', bg: 'bg-purple-50' },
                      { label: 'Confidence', value: `${(result.metrics.confidenceScore * 100).toFixed(0)}%`, icon: ShieldCheck, color: 'text-green-600', bg: 'bg-green-50' },
                    ].map((metric, i) => (
                      <Card key={i} className="border-gray-100 shadow-sm bg-white/50 backdrop-blur-sm">
                        <CardContent className="p-4 flex items-center gap-3">
                          <div className={`w-8 h-8 ${metric.bg} rounded-lg flex items-center justify-center`}>
                            <metric.icon className={`w-4 h-4 ${metric.color}`} />
                          </div>
                          <div>
                            <p className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">{metric.label}</p>
                            <p className="text-sm font-semibold text-gray-900">{metric.value}</p>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </motion.div>
                )}

                {result?.topics && result.topics.length > 0 && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex flex-wrap gap-2"
                  >
                    {result.topics.map((topic, i) => (
                      <Badge key={i} variant="secondary" className="bg-white border-gray-200 text-gray-600 font-normal hover:border-orange-200 transition-colors">
                        # {topic}
                      </Badge>
                    ))}
                  </motion.div>
                )}

                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  <Card className="border-gray-200 shadow-sm relative group">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-lg font-semibold">Executive Summary</CardTitle>
                        <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-100 text-[10px] uppercase tracking-wider font-bold">
                          Auditor Persona
                        </Badge>
                      </div>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-8 w-8 text-gray-400 hover:text-orange-600"
                        onClick={() => copyToClipboard(result?.summary || "")}
                      >
                        {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                      </Button>
                    </CardHeader>
                    <CardContent className="prose prose-sm max-w-none text-gray-600">
                      <div className="markdown-body">
                        <ReactMarkdown>{result?.summary || ""}</ReactMarkdown>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>

                {result?.comparativeAnalysis && (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1 }}
                  >
                    <Card className="border-gray-200 shadow-sm">
                      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-lg font-semibold flex items-center gap-2">
                          <Layers className="w-5 h-5 text-orange-600" />
                          Comparative Analysis
                        </CardTitle>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-8 w-8 text-gray-400 hover:text-orange-600"
                          onClick={() => copyToClipboard(result?.comparativeAnalysis || "")}
                        >
                          {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                        </Button>
                      </CardHeader>
                      <CardContent className="prose prose-sm max-w-none text-gray-600 overflow-x-auto">
                        <div className="markdown-body">
                          <ReactMarkdown>{result.comparativeAnalysis}</ReactMarkdown>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.1 }}
                  >
                    <Card className="border-gray-200 shadow-sm h-full">
                      <CardHeader>
                        <CardTitle className="text-sm font-medium text-gray-500 uppercase tracking-wider">Key Findings</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ul className="space-y-3">
                          {result?.keyFindings.map((finding, i) => (
                            <li key={i} className="flex gap-3 text-sm text-gray-700">
                              <span className="flex-shrink-0 w-5 h-5 bg-orange-100 text-orange-700 rounded-full flex items-center justify-center text-[10px] font-bold">
                                {i + 1}
                              </span>
                              {finding}
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                  </motion.div>

                  <motion.div
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.2 }}
                  >
                    <Card className="border-gray-200 shadow-sm h-full">
                      <CardHeader className="flex flex-row items-center justify-between space-y-0">
                        <CardTitle className="text-sm font-medium text-gray-500 uppercase tracking-wider">Data Visualization</CardTitle>
                        <div className="flex items-center gap-2">
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            className="h-7 text-[10px] text-gray-500 hover:text-orange-600 gap-1.5"
                            onClick={handleExportPython}
                          >
                            <Terminal className="w-3 h-3" />
                            Export Python
                          </Button>
                          <Badge variant="outline" className="text-[10px] font-normal">Interactive</Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="h-[200px]">
                          {result?.dataPoints && result.dataPoints.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                              <BarChart data={result.dataPoints}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F1F5F9" />
                                <XAxis 
                                  dataKey="label" 
                                  axisLine={false} 
                                  tickLine={false} 
                                  tick={{ fontSize: 10, fill: '#94A3B8' }}
                                />
                                <YAxis 
                                  axisLine={false} 
                                  tickLine={false} 
                                  tick={{ fontSize: 10, fill: '#94A3B8' }}
                                />
                                <Tooltip 
                                  cursor={{ fill: '#F8FAFC' }}
                                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
                                />
                                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                                  {result.dataPoints.map((entry, index) => (
                                    <Cell key={`cell-${index}`} fill={index % 2 === 0 ? '#EA580C' : '#F97316'} />
                                  ))}
                                </Bar>
                              </BarChart>
                            </ResponsiveContainer>
                          ) : (
                            <div className="h-full flex items-center justify-center text-gray-400 text-xs italic">
                              No structured data points identified for visualization
                            </div>
                          )}
                        </div>

                        <Separator className="bg-gray-100" />

                        <div className="space-y-3">
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Refine Data Points</p>
                          <div className="space-y-2">
                            {result?.dataPoints.map((dp, i) => (
                              <div key={i} className="flex items-center gap-2 group">
                                {editingDataIndex === i ? (
                                  <>
                                    <Input 
                                      className="h-7 text-xs flex-1" 
                                      value={dp.label} 
                                      onChange={(e) => updateDataPoint(i, e.target.value, dp.value.toString())}
                                    />
                                    <Input 
                                      className="h-7 text-xs w-20" 
                                      type="number"
                                      value={dp.value} 
                                      onChange={(e) => updateDataPoint(i, dp.label, e.target.value)}
                                    />
                                    <Button size="icon" variant="ghost" className="h-7 w-7 text-green-600" onClick={() => setEditingDataIndex(null)}>
                                      <Check className="w-3 h-3" />
                                    </Button>
                                  </>
                                ) : (
                                  <>
                                    <div className="flex-1 text-xs text-gray-700 truncate">{dp.label}</div>
                                    <div className="text-xs font-semibold text-gray-900 w-12 text-right">{dp.value}</div>
                                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                      <Button size="icon" variant="ghost" className="h-6 w-6 text-gray-400 hover:text-orange-600" onClick={() => setEditingDataIndex(i)}>
                                        <Edit2 className="w-3 h-3" />
                                      </Button>
                                      <Button size="icon" variant="ghost" className="h-6 w-6 text-gray-400 hover:text-red-600" onClick={() => removeDataPoint(i)}>
                                        <Trash2 className="w-3 h-3" />
                                      </Button>
                                    </div>
                                  </>
                                )}
                              </div>
                            ))}
                          </div>

                          <div className="flex gap-2 pt-2">
                            <Input 
                              placeholder="Label" 
                              className="h-8 text-xs flex-1" 
                              value={newDataLabel}
                              onChange={(e) => setNewDataLabel(e.target.value)}
                            />
                            <Input 
                              placeholder="Value" 
                              className="h-8 text-xs w-20" 
                              type="number"
                              value={newDataValue}
                              onChange={(e) => setNewDataValue(e.target.value)}
                            />
                            <Button size="icon" className="h-8 w-8 bg-orange-600 hover:bg-orange-700" onClick={addDataPoint}>
                              <PlusCircle className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                </div>

                {result?.risks && result.risks.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 }}
                  >
                    <Card className="border-red-100 shadow-sm bg-red-50/30">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-red-600 uppercase tracking-wider flex items-center gap-2">
                          <ShieldCheck className="w-4 h-4" />
                          Detected Risks & Red Flags
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ul className="space-y-2">
                          {result.risks.map((risk, i) => (
                            <li key={i} className="flex gap-3 text-sm text-gray-700 items-start">
                              <span className="mt-1.5 w-1.5 h-1.5 bg-red-500 rounded-full flex-shrink-0" />
                              {risk}
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                  </motion.div>
                )}

                <Card className="border-gray-200 shadow-sm">
                  <CardHeader>
                    <CardTitle className="text-sm font-medium text-gray-500 uppercase tracking-wider">Cited Sources</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {result?.sources.map((source, i) => (
                        <div key={i} className="p-3 bg-gray-50 rounded-lg border border-gray-100">
                          <div className="flex items-center justify-between mb-1">
                            <p className="text-xs font-semibold text-gray-900 truncate">{source.title}</p>
                            {source.page && <Badge variant="secondary" className="text-[10px] h-4 px-1">Page {source.page}</Badge>}
                          </div>
                          <p className="text-[11px] text-gray-500 line-clamp-2 italic">"{source.snippet}"</p>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="verification" className="space-y-6 mt-0">
                <Card className="border-gray-200 shadow-sm">
                  <CardHeader>
                    <CardTitle className="text-lg font-semibold flex items-center gap-2">
                      <ShieldCheck className="w-5 h-5 text-green-600" />
                      Agentic Fact Verification
                    </CardTitle>
                    <CardDescription>Claims verified using real-time Google Search grounding</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {result?.verifications.map((v, i) => (
                      <div key={i} className="flex items-start gap-4 p-4 rounded-xl border border-gray-100 bg-white shadow-sm">
                        <div className={`mt-1 w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${
                          v.status === 'verified' ? 'bg-green-100 text-green-700' : 
                          v.status === 'contradicted' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'
                        }`}>
                          {v.status === 'verified' ? <ShieldCheck className="w-4 h-4" /> : <Search className="w-3 h-3" />}
                        </div>
                        <div className="flex-1 space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-semibold text-gray-900">{v.claim}</p>
                            {v.truthScore !== undefined && (
                              <div className="flex flex-col items-end">
                                <span className="text-[10px] text-gray-400 uppercase font-bold">Truth Score</span>
                                <span className={`text-lg font-black ${
                                  v.truthScore > 80 ? 'text-green-600' : 
                                  v.truthScore > 50 ? 'text-yellow-600' : 'text-red-600'
                                }`}>
                                  {v.truthScore}%
                                </span>
                              </div>
                            )}
                          </div>

                          {v.searchQuery && (
                            <div className="flex items-center gap-1.5 text-[10px] text-gray-400 bg-gray-50 px-2 py-1 rounded w-fit">
                              <Terminal className="w-3 h-3" />
                              <span className="font-mono">Query: {v.searchQuery}</span>
                            </div>
                          )}

                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className={`text-[10px] uppercase tracking-wider ${
                              v.status === 'verified' ? 'border-green-200 text-green-700 bg-green-50' : 
                              v.status === 'contradicted' ? 'border-red-200 text-red-700 bg-red-50' : 'border-yellow-200 text-yellow-700 bg-yellow-50'
                            }`}>
                              {v.status}
                            </Badge>
                            {v.source && <span className="text-[10px] text-gray-400">Source: {v.source}</span>}
                          </div>

                          {v.explanation && (
                            <div className="mt-3 p-3 bg-gray-50/50 rounded-lg border border-gray-100 text-xs text-gray-600 leading-relaxed">
                              <p className="font-semibold text-gray-900 mb-1 flex items-center gap-1">
                                <Brain className="w-3 h-3 text-purple-600" />
                                Auditor Analysis
                              </p>
                              {v.explanation}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {(!result?.verifications || result.verifications.length === 0) && (
                      <div className="py-12 text-center text-gray-400 italic text-sm">
                        No major claims required external verification in this analysis.
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="chat" className="mt-0">
                <Card className="border-gray-200 shadow-sm h-[600px] flex flex-col">
                  <CardHeader className="border-b">
                    <CardTitle className="text-sm font-medium">Interactive Research Assistant</CardTitle>
                    <CardDescription>Ask specific questions about the uploaded corpus</CardDescription>
                  </CardHeader>
                  <CardContent className="flex-1 overflow-hidden p-0 flex flex-col">
                    <ScrollArea className="flex-1 p-4">
                      <div className="space-y-4">
                        <div className="bg-gray-50 p-3 rounded-lg text-sm text-gray-600 max-w-[80%]">
                          Hello! I've analyzed your documents. You can ask me to explain specific sections, compare data points, or verify facts from the web.
                        </div>
                        {chatMessages.map((msg, i) => (
                          <div 
                            key={i} 
                            className={`p-3 rounded-lg text-sm max-w-[80%] ${
                              msg.role === 'user' 
                                ? 'bg-orange-600 text-white ml-auto' 
                                : 'bg-gray-100 text-gray-700'
                            }`}
                          >
                            <div className="prose prose-invert prose-sm">
                              <ReactMarkdown>{msg.text}</ReactMarkdown>
                            </div>
                          </div>
                        ))}
                        {isChatting && (
                          <div className="bg-gray-100 p-3 rounded-lg text-sm text-gray-400 animate-pulse">
                            Assistant is thinking...
                          </div>
                        )}
                      </div>
                    </ScrollArea>
                    <div className="p-4 border-t bg-gray-50/50">
                      <form 
                        className="flex gap-2" 
                        onSubmit={(e) => { e.preventDefault(); handleChat(); }}
                      >
                        <Input 
                          placeholder="Ask a follow-up question..." 
                          className="bg-white" 
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          disabled={isChatting}
                        />
                        <Button 
                          type="submit"
                          className="bg-orange-600 hover:bg-orange-700"
                          disabled={isChatting || !chatInput.trim()}
                        >
                          {isChatting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                        </Button>
                      </form>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="tasks" className="mt-0">
                <Card className="border-gray-200 shadow-sm h-[600px] flex flex-col">
                  <CardHeader className="border-b">
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="text-sm font-medium">Research Plan & Execution</CardTitle>
                        <CardDescription>Break down your research into manageable steps and subtasks</CardDescription>
                      </div>
                      {notifications.length > 0 && (
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="bg-red-50 text-red-700 border-red-100 animate-pulse">
                            <Bell className="w-3 h-3 mr-1" />
                            {notifications.length} Alerts
                          </Badge>
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1 overflow-hidden p-0 flex flex-col">
                    {notifications.length > 0 && (
                      <div className="bg-red-50/50 border-b border-red-100 p-3 space-y-2">
                        {notifications.map((n) => (
                          <div key={n.id} className="flex items-center gap-2 text-[11px] font-medium text-red-700">
                            <AlertCircle className="w-3 h-3" />
                            {n.text}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="p-4 border-b bg-gray-50/50">
                      <div className="flex gap-2">
                        <Input 
                          placeholder="Add a main research task..." 
                          className="bg-white" 
                          value={newTaskText}
                          onChange={(e) => setNewTaskText(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && addTask()}
                        />
                        <Button 
                          className="bg-orange-600 hover:bg-orange-700"
                          onClick={() => addTask()}
                          disabled={!newTaskText.trim()}
                        >
                          <Plus className="w-4 h-4 mr-2" />
                          Add Task
                        </Button>
                      </div>
                    </div>
                    <ScrollArea className="flex-1 p-6">
                      <DragDropContext onDragEnd={onDragEnd}>
                        <Droppable droppableId="tasks-root" type="tasks-root">
                          {(provided) => (
                            <div 
                              {...provided.droppableProps}
                              ref={provided.innerRef}
                              className="space-y-4"
                            >
                              {tasks.length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center text-gray-400 py-20">
                                  <ListTodo className="w-12 h-12 mb-4 opacity-20" />
                                  <p className="text-sm">No tasks defined for this session.</p>
                                  <p className="text-xs mt-1">Start by adding your first research objective above.</p>
                                </div>
                              ) : (
                                tasks.map((task, i) => (
                                  <TaskItem key={task.id} task={task} index={i} />
                                ))
                              )}
                              {provided.placeholder}
                            </div>
                          )}
                        </Droppable>
                      </DragDropContext>
                    </ScrollArea>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </main>
    </div>
  );
}

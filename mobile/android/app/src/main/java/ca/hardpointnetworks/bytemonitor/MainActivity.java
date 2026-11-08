package ca.hardpointnetworks.bytemonitor;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ByteMonitorPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

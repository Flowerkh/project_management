package egovframework.shop.system.service.impl;

import javax.annotation.Resource;
import org.springframework.stereotype.Service;
import egovframework.rte.fdl.cmmn.EgovAbstractServiceImpl;
import egovframework.shop.system.service.SysService;
import egovframework.shop.system.service.SysVO;

@Service("sysservice")
public class SysServiceImpl extends EgovAbstractServiceImpl implements SysService {

    @Resource(name = "sysdao")
    private SysDAO sysdao;

    @Override
    public Object selectMenuList(SysVO vo) throws Exception {
        return sysdao.selectMenuList(vo);
    }

    @Override
    public Object insertMenu(SysVO vo) throws Exception {
        return sysdao.insertMenu(vo);
    }

    @Override
    public Object deleteMenu(SysVO vo) throws Exception {
        return sysdao.deleteMenu(vo);
    }

    @Override
    public Object selectCodeList(SysVO vo) throws Exception {
        return sysdao.selectCodeList(vo);
    }

    @Override
    public Object mergeCodeDetail(SysVO vo) throws Exception {
        return sysdao.mergeCodeDetail(vo);
    }

    @Override
    public Object selectAdminList(SysVO vo) throws Exception {
        return sysdao.selectAdminList(vo);
    }

    @Override
    public Object updateAdminAuth(SysVO vo) throws Exception {
        return sysdao.updateAdminAuth(vo);
    }

    @Override
    public Object selectLoginLogList(SysVO vo) throws Exception {
        return sysdao.selectLoginLogList(vo);
    }

    @Override
    public Object selectDynamic(SysVO vo) throws Exception {
        return sysdao.selectDynamic(vo);
    }

}
